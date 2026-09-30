"""Deterministic release-only thumbnail; never overwrite the authoring icon."""
import sys
from pathlib import Path
from PIL import Image

source, target = map(Path, sys.argv[1:])
assert source.resolve() != target.resolve()
with Image.open(source) as image:
    assert image.width == image.height
    image.convert('RGBA').resize((256, 256), Image.Resampling.LANCZOS).save(
        target, format='PNG', optimize=True, compress_level=9)
with Image.open(target) as image:
    assert image.size == (256, 256) and image.mode == 'RGBA'
