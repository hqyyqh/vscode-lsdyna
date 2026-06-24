"""Build LS-DYNA snippet and hover schema data from pydyna codegen inputs."""

from __future__ import annotations

import ast
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
LOCAL_ALIASES = {
    "SET_PART_LIST": "SET_PART",
}
MANUAL_KEYWORD_CLASSES_DIR = Path("src") / "ansys" / "dyna" / "core" / "keywords" / "keyword_classes" / "manual"


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

    for canonical, alias in LOCAL_ALIASES.items():
        if canonical not in kwd_set:
            continue
        if data_model.is_aliased(alias):
            continue
        data_model.add_alias(canonical, alias)

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


def _manual_field_type(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        value = node.id
    elif isinstance(node, ast.Attribute):
        value = node.attr
    else:
        value = ""
    return {
        "int": "integer",
        "float": "real",
        "str": "string",
    }.get(value, value)


def _clean_default(value: Any) -> Any:
    if isinstance(value, str) and len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1]
    return value


def _literal_value(node: ast.AST | None) -> Any:
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = _literal_value(node.operand)
        if isinstance(value, (int, float)):
            return -value
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "ReadOnlyValue":
        return _literal_value(node.args[0]) if node.args else None
    return None


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

        if len(fields) == 1 and width > 80:
            line = "$# " + name
            written = len(line)
            continue

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


def _add_alias_title_variants(
    canonical_name: str,
    alias_name: str,
    field_data: dict[str, dict[str, Any]],
    snippets: dict[str, dict[str, Any]],
) -> None:
    canonical_entry = field_data.get(canonical_name)
    if not canonical_entry:
        return

    title_options = canonical_entry.get("o", [])
    for canonical_variant_name, variant in (canonical_entry.get("v") or {}).items():
        active = variant.get("active")
        if not active or canonical_variant_name not in field_data:
            continue

        alias_variant_name = f"{alias_name}_{'_'.join(active)}"
        alias_variant_entry = copy.deepcopy(field_data[canonical_variant_name])
        alias_variant_entry["x"] = canonical_variant_name
        alias_variant_entry["active"] = list(active)
        field_data[alias_variant_name] = alias_variant_entry

        selected_options = [option for option in title_options if option["n"] in active]
        rendered_cards = _render_cards(canonical_entry["c"], selected_options)
        snippets[f"*{alias_variant_name}"] = _build_snippet(alias_variant_name, rendered_cards)


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


def _manual_field_schema(call: ast.Call) -> dict[str, Any] | None:
    if not isinstance(call.func, ast.Name) or call.func.id != "FieldSchema":
        return None
    if len(call.args) < 5:
        return None

    name = _literal_value(call.args[0])
    position = _literal_value(call.args[2])
    width = _literal_value(call.args[3])
    if not isinstance(name, str) or not isinstance(position, int) or not isinstance(width, int):
        return None

    label = _literal_value(call.args[5]) if len(call.args) > 5 else None
    display_name = label if isinstance(label, str) and label else name
    field: dict[str, Any] = {
        "n": display_name.upper(),
        "p": position,
        "w": width,
        "h": "",
        "t": _manual_field_type(call.args[1]),
    }

    default = _clean_default(_literal_value(call.args[4]))
    if default is not None:
        field["d"] = default

    return field


def _manual_card_definitions(tree: ast.Module) -> dict[str, list[dict[str, Any]]]:
    definitions: dict[str, list[dict[str, Any]]] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        target_names = [target.id for target in node.targets if isinstance(target, ast.Name)]
        if not target_names or not isinstance(node.value, (ast.Tuple, ast.List)):
            continue

        fields = []
        for item in node.value.elts:
            if not isinstance(item, ast.Call):
                fields = []
                break
            field = _manual_field_schema(item)
            if not field:
                fields = []
                break
            fields.append(field)

        if fields:
            for target_name in target_names:
                definitions[target_name] = fields
    return definitions


def _manual_text_card(call: ast.Call) -> list[dict[str, Any]] | None:
    if not isinstance(call.func, ast.Name) or call.func.id != "TextCard":
        return None
    if not call.args:
        return None
    name = _literal_value(call.args[0])
    if not isinstance(name, str) or not name:
        return None
    return [{"n": name.upper(), "p": 0, "w": 80, "h": "", "t": "string"}]


def _manual_card_from_call(call: ast.Call, definitions: dict[str, list[dict[str, Any]]]) -> list[list[dict[str, Any]]]:
    if isinstance(call.func, ast.Attribute) and call.func.attr == "from_field_schemas_with_defaults":
        if call.args and isinstance(call.args[0], ast.Name) and call.args[0].id in definitions:
            return [copy.deepcopy(definitions[call.args[0].id])]
        return []

    if isinstance(call.func, ast.Name) and call.func.id == "TableCardGroup":
        if not call.args or not isinstance(call.args[0], (ast.List, ast.Tuple)):
            return []
        cards = []
        for item in call.args[0].elts:
            if isinstance(item, ast.Name) and item.id in definitions:
                cards.append(copy.deepcopy(definitions[item.id]))
        return cards

    text_card = _manual_text_card(call)
    if text_card:
        return [text_card]

    return []


def _manual_cards_assignment(init_func: ast.FunctionDef) -> ast.List | ast.Tuple | None:
    for node in ast.walk(init_func):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if (
                isinstance(target, ast.Attribute)
                and target.attr == "_cards"
                and isinstance(target.value, ast.Name)
                and target.value.id == "self"
                and isinstance(node.value, (ast.List, ast.Tuple))
            ):
                return node.value
    return None


def _manual_class_keyword_name(class_node: ast.ClassDef) -> str | None:
    keyword = None
    subkeyword = None
    for stmt in class_node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        for target in stmt.targets:
            if not isinstance(target, ast.Name):
                continue
            if target.id == "keyword":
                keyword = _literal_value(stmt.value)
            elif target.id == "subkeyword":
                subkeyword = _literal_value(stmt.value)

    if not isinstance(keyword, str) or not keyword:
        return None
    raw_name = f"{keyword}_{subkeyword}" if isinstance(subkeyword, str) and subkeyword else keyword
    return keyword_name(raw_name)


def _manual_entry_from_class(
    class_node: ast.ClassDef,
    definitions: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    init_func = next(
        (node for node in class_node.body if isinstance(node, ast.FunctionDef) and node.name == "__init__"),
        None,
    )
    if not init_func:
        return None

    assignment = _manual_cards_assignment(init_func)
    if assignment is None:
        return None

    cards: list[list[dict[str, Any]]] = []
    repeats = False
    for item in assignment.elts:
        if not isinstance(item, ast.Call):
            continue
        item_cards = _manual_card_from_call(item, definitions)
        if item_cards:
            cards.extend(item_cards)
        if isinstance(item.func, ast.Name) and item.func.id == "TableCardGroup":
            repeats = True

    if not cards:
        return None

    entry: dict[str, Any] = {"c": cards}
    if repeats:
        entry["r"] = 1
    return entry


def _manual_schema_entries(codegen_dir: Path) -> dict[str, dict[str, Any]]:
    manual_dir = codegen_dir.parent / MANUAL_KEYWORD_CLASSES_DIR
    if not manual_dir.exists():
        return {}

    entries: dict[str, dict[str, Any]] = {}
    for path in sorted(manual_dir.glob("*.py")):
        if path.name == "__init__.py" or "_version_" in path.stem:
            continue

        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        definitions = _manual_card_definitions(tree)
        for class_node in (node for node in tree.body if isinstance(node, ast.ClassDef)):
            name = _manual_class_keyword_name(class_node)
            if not name:
                continue
            entry = _manual_entry_from_class(class_node, definitions)
            if entry:
                entries[name] = entry

    return entries


def _sync_entry_shape_from_manual(entry: dict[str, Any], manual_entry: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(entry)
    merged["c"] = copy.deepcopy(manual_entry["c"])
    if manual_entry.get("r"):
        merged["r"] = manual_entry["r"]
    else:
        merged.pop("r", None)
    return merged


def _compact_field_signature(field: dict[str, Any]) -> tuple[Any, Any, Any, Any, Any]:
    return (
        field.get("n"),
        field.get("p"),
        field.get("w"),
        field.get("t"),
        field.get("d"),
    )


def _compact_cards_equal(cards1: list[list[dict[str, Any]]], cards2: list[list[dict[str, Any]]]) -> bool:
    if len(cards1) != len(cards2):
        return False
    for card1, card2 in zip(cards1, cards2):
        if len(card1) != len(card2):
            return False
        for field1, field2 in zip(card1, card2):
            if _compact_field_signature(field1) != _compact_field_signature(field2):
                return False
    return True


def _render_entry_snippet_cards(entry: dict[str, Any], active_options: list[str] | None = None) -> list[list[dict[str, Any]]]:
    if not active_options:
        return entry["c"]
    selected_options = [option for option in entry.get("o", []) if option["n"] in active_options]
    return _render_cards(entry["c"], selected_options)


def _apply_manual_schema_overrides(
    codegen_dir: Path,
    field_data: dict[str, dict[str, Any]],
    snippets: dict[str, dict[str, Any]],
) -> int:
    manual_entries = _manual_schema_entries(codegen_dir)
    override_count = 0

    for name, manual_entry in manual_entries.items():
        if name in field_data and _compact_cards_equal(field_data[name].get("c", []), manual_entry["c"]):
            continue

        if name not in field_data:
            field_data[name] = copy.deepcopy(manual_entry)
        else:
            field_data[name] = _sync_entry_shape_from_manual(field_data[name], manual_entry)
        snippets[f"*{name}"] = _build_snippet(name, _render_entry_snippet_cards(field_data[name]))
        override_count += 1

        for alias_name, alias_entry in list(field_data.items()):
            if alias_name == name or normalize_keyword_reference(alias_entry.get("x")) != name:
                continue
            field_data[alias_name] = _sync_entry_shape_from_manual(alias_entry, manual_entry)
            active_options = field_data[alias_name].get("active")
            snippets[f"*{alias_name}"] = _build_snippet(
                alias_name,
                _render_entry_snippet_cards(field_data[name], active_options),
            )

    return override_count


def normalize_keyword_reference(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return keyword_name(value.strip().replace("*", "").upper())


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
        _add_alias_title_variants(canonical_name, alias_name, field_data, snippets)

    manual_overrides = _apply_manual_schema_overrides(codegen_dir, field_data, snippets)
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
            "manual_overrides": manual_overrides,
            "option_enabled": option_enabled,
            "title_variants": variant_count,
            "field_entries": len(field_data),
            "snippets": len(snippets),
        },
    )
