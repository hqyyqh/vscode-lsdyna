"""Build LS-DYNA snippet and hover schema data from pydyna codegen inputs."""

from __future__ import annotations

import copy
from dataclasses import dataclass
import importlib
import itertools
import logging
from pathlib import Path
import sys
from typing import Any


WIDE_FIELD_THRESHOLD = 40
TITLE_VARIANT_LIMIT = 32


@dataclass
class GeneratedSchema:
    field_data: dict[str, dict[str, Any]]
    snippets: dict[str, dict[str, Any]]
    stats: dict[str, int]


def keyword_name(key: str) -> str:
    tokens = key.split("_")
    if len(tokens) == 2 and tokens[0] == tokens[1]:
        return tokens[0]
    return key


def _import_pydyna_codegen(codegen_dir: Path):
    codegen_path = str(codegen_dir.resolve())
    if codegen_path not in sys.path:
        sys.path.insert(0, codegen_path)

    data_model = importlib.import_module("keyword_generation.data_model")
    class_generator = importlib.import_module("keyword_generation.generators.class_generator")
    utils = importlib.import_module("keyword_generation.utils")
    logging.getLogger("keyword_generation.handlers.handler_base").setLevel(logging.ERROR)
    return data_model, class_generator._get_keyword_data, utils.merge_options, utils.merge_labels


def _match_wildcard_pattern(keyword: str, pattern: str, wildcard_type: str) -> bool:
    if wildcard_type == "prefix":
        return keyword.startswith(pattern)
    if wildcard_type == "exact":
        return keyword == pattern
    raise ValueError(f"Unexpected wildcard type: {wildcard_type}")


def _match_wildcard(keyword: str, wildcard: dict[str, Any]) -> bool:
    exclusions = wildcard.get("exclusions", [])
    for exclusion in exclusions:
        if keyword.startswith(exclusion):
            return False

    wildcard_type = wildcard["type"]
    return any(_match_wildcard_pattern(keyword, pattern, wildcard_type) for pattern in wildcard["patterns"])


def _get_keyword_action(config: Any, keyword: str) -> str:
    return config.manifest.get_keyword_options(keyword).get("action", "generate")


def _get_keyword_options(
    config: Any,
    keyword: str,
    merge_options: Any,
    merge_labels: Any,
    wildcards: bool = True,
) -> dict[str, Any]:
    keyword_options = copy.deepcopy(config.manifest.get(keyword, {}))
    if not wildcards or _get_keyword_action(config, keyword) == "skip":
        return keyword_options

    for wildcard in config.manifest.get_wildcards():
        if not _match_wildcard(keyword, wildcard):
            continue
        merge_options(keyword_options, wildcard.get("generation-options", {}))
        if "labels" in wildcard:
            labels = keyword_options.setdefault("labels", {})
            merge_labels(labels, wildcard["labels"])

    return keyword_options


def _field_signature(field: dict[str, Any]) -> tuple[Any, Any, Any, Any]:
    return (
        field.get("name"),
        field.get("type"),
        field.get("position"),
        field.get("width"),
    )


def _definitions_identical(config: Any, keyword1: str, keyword2: str) -> bool:
    try:
        cards1 = config.keyword_data.get_keyword_data_dict(keyword1)
        cards2 = config.keyword_data.get_keyword_data_dict(keyword2)
    except KeyError:
        return False

    if len(cards1) != len(cards2):
        return False

    for card1, card2 in zip(cards1, cards2):
        fields1 = card1.get("fields", [])
        fields2 = card2.get("fields", [])
        if len(fields1) != len(fields2):
            return False
        for field1, field2 in zip(fields1, fields2):
            if _field_signature(field1) != _field_signature(field2):
                return False

    return True


def _register_aliases(config: Any, data_model: Any, kwd_list: list[str]) -> None:
    kwd_set = set(kwd_list)

    for keyword in kwd_list:
        options = config.manifest.get_keyword_options(keyword)
        alias = options.get("alias")
        if alias:
            data_model.add_alias(keyword, alias)

    for keyword in kwd_list:
        if "-" not in keyword:
            continue
        underscore_variant = keyword.replace("-", "_")
        if underscore_variant not in kwd_set:
            continue
        if data_model.is_aliased(underscore_variant):
            continue
        if _definitions_identical(config, keyword, underscore_variant):
            data_model.add_alias(keyword, underscore_variant)


def _keyword_items(config: Any, merge_options: Any, merge_labels: Any) -> list[dict[str, Any]]:
    kwd_list = config.keyword_data.get_keywords_list()
    kwd_set = set(kwd_list)
    manifest_keys = sorted(config.manifest.get_keyword_keys())
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    for keyword in kwd_list:
        if keyword in seen:
            continue
        seen.add(keyword)
        options = _get_keyword_options(config, keyword, merge_options, merge_labels)
        items.append({"name": keyword, "options": options})

    for keyword in manifest_keys:
        if keyword in seen:
            continue
        options = config.manifest.get(keyword, {})
        source = options.get("source-keyword", keyword)
        if source not in kwd_set:
            continue
        seen.add(keyword)
        merged = _get_keyword_options(config, keyword, merge_options, merge_labels)
        items.append({"name": keyword, "options": merged})

    return items


def _field_display_name(field: Any) -> str:
    name = str(field.get("name", "") if hasattr(field, "get") else "")
    if not name:
        return ""
    return name.upper()


def _field_type(field: Any) -> str:
    value = str(field.get("type", "") if hasattr(field, "get") else "")
    return {
        "int": "integer",
        "float": "real",
        "str": "string",
    }.get(value, value)


def _clean_default(value: Any) -> Any:
    if isinstance(value, str) and len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1]
    return value


def _card_active(card: Any) -> str | None:
    for key in ("active", "func", "active_func"):
        value = card.get(key) if hasattr(card, "get") else None
        if value:
            return str(value)

    for meta_key in ("table", "variable"):
        meta = card.get(meta_key) if hasattr(card, "get") else None
        if not meta:
            continue
        if hasattr(meta, "active_func") and meta.active_func:
            return str(meta.active_func)
        if isinstance(meta, dict) and meta.get("active_func"):
            return str(meta["active_func"])

    return None


def _serialize_field(field: Any, active: str | None = None) -> dict[str, Any]:
    serialized: dict[str, Any] = {
        "n": _field_display_name(field),
        "p": field.get("position", 0),
        "w": field.get("width", 10),
        "h": field.get("help", "") or "",
        "t": _field_type(field),
    }

    default = _clean_default(field.get("default"))
    if default is not None:
        serialized["d"] = default

    options = field.get("options", [])
    if options:
        serialized["e"] = [_clean_default(option) for option in options]

    if active:
        serialized["active"] = active

    return serialized


def _serialize_single_card(card: Any, inherited_active: str | None = None) -> list[dict[str, Any]]:
    active = inherited_active or _card_active(card)
    fields = card.get_all_fields() if hasattr(card, "get_all_fields") else card.get("fields", [])
    return [_serialize_field(field, active=active) for field in fields]


def _serialize_cards(cards: list[Any]) -> list[list[dict[str, Any]]]:
    serialized: list[list[dict[str, Any]]] = []
    for card in cards:
        active = _card_active(card)
        sub_cards = card.get("sub_cards") if hasattr(card, "get") else None
        if card.get("table_group", False) and sub_cards:
            for sub_card in sub_cards:
                serialized.append(_serialize_single_card(sub_card, inherited_active=active))
            continue
        serialized.append(_serialize_single_card(card, inherited_active=active))
    return serialized


def _serialize_options(options: list[Any]) -> list[dict[str, Any]]:
    serialized = []
    for option in options or []:
        name = option.name if hasattr(option, "name") else option["name"]
        card_order = option.card_order if hasattr(option, "card_order") else option["card_order"]
        title_order = option.title_order if hasattr(option, "title_order") else option["title_order"]
        cards = option.cards if hasattr(option, "cards") else option["cards"]
        serialized_option = {
            "n": name,
            "co": card_order,
            "to": title_order,
            "c": _serialize_cards(cards),
        }
        func = option.func if hasattr(option, "func") else option.get("func")
        if func:
            serialized_option["active"] = func
        serialized.append(serialized_option)
    return serialized


def _get_card_sets(keyword_data: Any) -> list[Any]:
    card_sets = getattr(keyword_data, "card_sets", None)
    if not card_sets:
        return []
    if hasattr(card_sets, "sets"):
        return list(card_sets.sets)
    return list(card_sets.get("sets", []))


def _card_set_name(card_set: Any) -> str:
    return card_set.name if hasattr(card_set, "name") else card_set.get("name", "")


def _card_set_source_cards(card_set: Any) -> list[Any]:
    if hasattr(card_set, "source_cards"):
        return list(card_set.source_cards)
    return list(card_set.get("source_cards", []))


def _card_set_options(card_set: Any) -> list[Any]:
    if hasattr(card_set, "options"):
        return list(card_set.options or [])
    return list(card_set.get("options", []))


def _card_set_name_from_placeholder(card: Any) -> str | None:
    card_set = card.get("set") if hasattr(card, "get") else None
    if not card_set:
        return None
    if hasattr(card_set, "name"):
        return card_set.name
    return card_set.get("name")


def _base_cards(keyword_data: Any) -> list[Any]:
    sets = _get_card_sets(keyword_data)
    source_by_name = {_card_set_name(card_set): _card_set_source_cards(card_set) for card_set in sets}
    cards: list[Any] = []

    for card in keyword_data.cards:
        set_name = _card_set_name_from_placeholder(card)
        if set_name and set_name in source_by_name:
            cards.extend(source_by_name[set_name])
            continue
        cards.append(card)

    if not cards and source_by_name:
        for source_cards in source_by_name.values():
            cards.extend(source_cards)

    return cards


def _all_options(keyword_data: Any) -> list[Any]:
    options = list(keyword_data.options or [])
    for card_set in _get_card_sets(keyword_data):
        options.extend(_card_set_options(card_set))
    return options


def _is_repeating(keyword_data: Any, generation_options: dict[str, Any]) -> bool:
    repeat_keys = ("table-card", "series-card", "table-card-group")
    if any(key in generation_options for key in repeat_keys):
        return True
    return bool(
        getattr(keyword_data, "table", False)
        or getattr(keyword_data, "variable", False)
        or getattr(keyword_data, "table_group", False)
    )


def _comment_header(fields: list[dict[str, Any]]) -> str:
    line = "$#"
    written = 2
    for i, field in enumerate(fields):
        pos = field.get("p", 0)
        width = field.get("w", 10)
        available = (pos + width) - written
        if available <= 0:
            continue
        name = str(field["n"]).lower()[:available]
        
        if width >= 40:
            if i == 0:
                line = ("$# " + name).ljust(pos + width)
            else:
                line += name.ljust(available)
        else:
            line += name.rjust(available)
            
        written = pos + width
    return line


def _data_line(fields: list[dict[str, Any]], tab_start: int) -> tuple[str, int]:
    line = ""
    cursor = 0
    tab = tab_start
    for field in fields:
        pos = field.get("p", cursor)
        width = field.get("w", 10)
        default = field.get("d")
        if pos > cursor:
            line += " " * (pos - cursor)

        placeholder_value = str(default if default is not None else field["n"])[:width]
        if width >= 40:
            placeholder = placeholder_value.ljust(width)
        else:
            placeholder = placeholder_value.rjust(width)
        line += f"${{{tab}:{placeholder}}}"
        tab += 1
        cursor = pos + width

    return line, tab


def _build_snippet(name: str, cards: list[list[dict[str, Any]]], description: str | None = None) -> dict[str, Any]:
    full_keyword = f"*{name}"
    body = [full_keyword]
    tab = 1

    for card in cards:
        if not card:
            continue
        if len(card) == 1 and card[0].get("w", 0) >= WIDE_FIELD_THRESHOLD:
            body.append(_comment_header(card))
            body.append(f'${{{tab}:{card[0]["n"]}}}')
            tab += 1
            continue

        body.append(_comment_header(card))
        line, tab = _data_line(card, tab)
        body.append(line)

    body.append("$0")
    return {
        "prefix": [full_keyword, name],
        "body": body,
        "description": description or name,
    }


def _parse_card_order(card_order: str) -> tuple[str, int]:
    try:
        position, raw_index = card_order.split("/", 1)
        return position, int(raw_index)
    except ValueError:
        return card_order, 0


def _render_cards(base_cards: list[list[dict[str, Any]]], options: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    pre: list[tuple[int, dict[str, Any]]] = []
    main: list[tuple[int, dict[str, Any]]] = []
    post: list[tuple[int, dict[str, Any]]] = []

    for option in options:
        position, index = _parse_card_order(option["co"])
        bucket = {"pre": pre, "main": main, "post": post}.get(position, post)
        bucket.append((index, option))

    rendered: list[list[dict[str, Any]]] = []
    for _, option in sorted(pre, key=lambda item: item[0]):
        rendered.extend(copy.deepcopy(option["c"]))

    rendered.extend(copy.deepcopy(base_cards))

    inserted = 0
    for index, option in sorted(main, key=lambda item: item[0]):
        insert_at = max(0, min(len(rendered), index + 1 + inserted))
        rendered[insert_at:insert_at] = copy.deepcopy(option["c"])
        inserted += len(option["c"])

    for _, option in sorted(post, key=lambda item: item[0]):
        rendered.extend(copy.deepcopy(option["c"]))

    return rendered


def _title_variant_options(options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted((option for option in options if option.get("to", 0) > 0), key=lambda option: option["to"])


def _add_title_variants(
    name: str,
    entry: dict[str, Any],
    field_data: dict[str, dict[str, Any]],
    snippets: dict[str, dict[str, Any]],
) -> None:
    title_options = _title_variant_options(entry.get("o", []))
    if not title_options:
        return

    variants: dict[str, dict[str, Any]] = {}
    combination_count = (2 ** len(title_options)) - 1
    if combination_count > TITLE_VARIANT_LIMIT:
        entry["v"] = {
            "limitExceeded": {
                "active": [option["n"] for option in title_options],
                "count": combination_count,
            }
        }
        return

    for size in range(1, len(title_options) + 1):
        for selected in itertools.combinations(title_options, size):
            active = [option["n"] for option in sorted(selected, key=lambda option: option["to"])]
            variant_name = f"{name}_{'_'.join(active)}"
            rendered_cards = _render_cards(entry["c"], list(selected))
            variants[variant_name] = {"active": active}
            if variant_name not in field_data:
                variant_entry = {
                    "c": copy.deepcopy(entry["c"]),
                    "x": name,
                    "active": active,
                }
                if entry.get("r"):
                    variant_entry["r"] = entry["r"]
                field_data[variant_name] = variant_entry
            snippets[f"*{variant_name}"] = _build_snippet(variant_name, rendered_cards)

    if variants:
        entry["v"] = variants


def _post_option_index(option: dict[str, Any]) -> int | None:
    position, index = _parse_card_order(option["co"])
    if position != "post":
        return None
    return index


def _post_option_chain(entry: dict[str, Any]) -> list[dict[str, Any]]:
    post_options = [
        option
        for option in entry.get("o", [])
        if _post_option_index(option) is not None and len(option["n"]) == 1 and "A" <= option["n"] <= "Z"
    ]
    if not post_options:
        return []

    post_options = sorted(post_options, key=lambda option: _post_option_index(option) or 0)
    expected = ord("A")
    chain: list[dict[str, Any]] = []
    for option in post_options:
        if ord(option["n"]) != expected:
            break
        chain.append(option)
        expected += 1
    return chain


def _add_post_option_snippets(name: str, entry: dict[str, Any], snippets: dict[str, dict[str, Any]]) -> None:
    chain = _post_option_chain(entry)
    if not chain:
        return

    for option in chain:
        active_post = [candidate for candidate in chain if candidate["n"] <= option["n"]]
        rendered_cards = _render_cards(entry["c"], active_post)
        snippet_key = f"*{name}_OPTION_{option['n']}"
        snippet = _build_snippet(name, rendered_cards, description=f"{name} + Optional Cards A-{option['n']}")
        snippet["prefix"] = [f"*{name}_{option['n']}", f"{name}_{option['n']}", snippet["prefix"][0], name]
        snippets[snippet_key] = snippet

    title_options = _title_variant_options(entry.get("o", []))
    if not title_options:
        return

    combination_count = (2 ** len(title_options)) - 1
    if combination_count > TITLE_VARIANT_LIMIT:
        return

    for size in range(1, len(title_options) + 1):
        for selected in itertools.combinations(title_options, size):
            selected_options = list(selected)
            active_title = [option["n"] for option in sorted(selected_options, key=lambda option: option["to"])]
            variant_name = f"{name}_{'_'.join(active_title)}"
            for option in chain:
                active_post = [candidate for candidate in chain if candidate["n"] <= option["n"]]
                rendered_cards = _render_cards(entry["c"], selected_options + active_post)
                snippet_key = f"*{variant_name}_OPTION_{option['n']}"
                snippet = _build_snippet(
                    variant_name,
                    rendered_cards,
                    description=f"{variant_name} + Optional Cards A-{option['n']}",
                )
                snippet["prefix"] = [
                    f"*{variant_name}_{option['n']}",
                    f"{variant_name}_{option['n']}",
                    f"*{variant_name}",
                    variant_name,
                ]
                snippets[snippet_key] = snippet


def _entry_from_keyword_data(keyword_data: Any, generation_options: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "c": _serialize_cards(_base_cards(keyword_data)),
    }

    if _is_repeating(keyword_data, generation_options):
        entry["r"] = 1

    options = _serialize_options(_all_options(keyword_data))
    if options:
        entry["o"] = options

    return entry


def build_schema(codegen_dir: Path, kwd_file: Path | None = None) -> GeneratedSchema:
    """Return snippets and compact field data generated from pydyna codegen inputs."""
    codegen_dir = Path(codegen_dir)
    kwd_path = Path(kwd_file) if kwd_file else codegen_dir / "kwd.json"

    data_model, get_keyword_data, merge_options, merge_labels = _import_pydyna_codegen(codegen_dir)
    data_model.load(str(codegen_dir), str(kwd_path), "", "")
    config = data_model.get_config()

    kwd_list = config.keyword_data.get_keywords_list()
    _register_aliases(config, data_model, kwd_list)
    items = _keyword_items(config, merge_options, merge_labels)

    field_data: dict[str, dict[str, Any]] = {}
    snippets: dict[str, dict[str, Any]] = {}
    skipped = 0

    for item in items:
        name = keyword_name(item["name"])
        if _get_keyword_action(config, item["name"]) == "skip":
            skipped += 1
            continue
        if data_model.is_aliased(item["name"]):
            skipped += 1
            continue

        options = item["options"]
        source_keyword = options.get("source-keyword", item["name"])
        generation_options = options.get("generation-options", {})
        keyword_data = get_keyword_data(item["name"], source_keyword, generation_options, initial_labels=options.get("labels"))
        entry = _entry_from_keyword_data(keyword_data, generation_options)

        alias = data_model.get_alias(item["name"])
        if alias:
            entry["a"] = [keyword_name(alias)]

        field_data[name] = entry
        snippets[f"*{name}"] = _build_snippet(name, entry["c"])
        _add_title_variants(name, entry, field_data, snippets)
        _add_post_option_snippets(name, entry, snippets)

    for alias, canonical in config.get_aliases().items():
        canonical_name = keyword_name(canonical)
        alias_name = keyword_name(alias)
        if canonical_name not in field_data:
            continue
        alias_entry = copy.deepcopy(field_data[canonical_name])
        alias_entry["x"] = canonical_name
        field_data[alias_name] = alias_entry
        snippets[f"*{alias_name}"] = _build_snippet(alias_name, alias_entry["c"])

    option_enabled = sum(1 for entry in field_data.values() if entry.get("o"))
    variant_count = sum(len(entry.get("v", {})) for entry in field_data.values())
    alias_count = len(config.get_aliases())

    return GeneratedSchema(
        field_data=field_data,
        snippets=snippets,
        stats={
            "kwd_keywords": len(kwd_list),
            "items": len(items),
            "skipped": skipped,
            "aliases": alias_count,
            "option_enabled": option_enabled,
            "title_variants": variant_count,
            "field_entries": len(field_data),
            "snippets": len(snippets),
        },
    )
