"""Timeline font catalog — paths mirror ui/frontend/src/lib/timelineFonts.ts."""

from __future__ import annotations

from pathlib import Path

_FONTS_ROOT = (
    Path(__file__).resolve().parents[1] / "ui" / "frontend" / "public" / "fonts"
).resolve()

_CATALOG: dict[str, dict[int, str]] = {
    "inter": {400: "inter/Inter-Regular.ttf", 700: "inter/Inter-Bold.ttf"},
    "roboto": {400: "roboto/Roboto-Regular.ttf", 700: "roboto/Roboto-Bold.ttf"},
    "open-sans": {400: "open-sans/OpenSans-Regular.ttf", 700: "open-sans/OpenSans-Bold.ttf"},
    "lato": {400: "lato/Lato-Regular.ttf", 700: "lato/Lato-Bold.ttf"},
    "montserrat": {400: "montserrat/Montserrat-Regular.ttf", 700: "montserrat/Montserrat-Bold.ttf"},
    "raleway": {400: "raleway/Raleway-Regular.ttf", 700: "raleway/Raleway-Bold.ttf"},
    "poppins": {400: "poppins/Poppins-Regular.ttf", 700: "poppins/Poppins-Bold.ttf"},
    "nunito": {400: "nunito/Nunito-Regular.ttf", 700: "nunito/Nunito-Bold.ttf"},
    "source-sans-3": {400: "source-sans-3/SourceSans3-Regular.ttf", 700: "source-sans-3/SourceSans3-Bold.ttf"},
    "ubuntu": {400: "ubuntu/Ubuntu-Regular.ttf", 700: "ubuntu/Ubuntu-Bold.ttf"},
    "rubik": {400: "rubik/Rubik-Regular.ttf", 700: "rubik/Rubik-Bold.ttf"},
    "oswald": {400: "oswald/Oswald-Regular.ttf", 700: "oswald/Oswald-Bold.ttf"},
    "bebas-neue": {400: "bebas-neue/BebasNeue-Regular.ttf"},
    "playfair-display": {400: "playfair-display/PlayfairDisplay-Regular.ttf", 700: "playfair-display/PlayfairDisplay-Bold.ttf"},
    "merriweather": {400: "merriweather/Merriweather-Regular.ttf", 700: "merriweather/Merriweather-Bold.ttf"},
    "noto-sans": {400: "noto-sans/NotoSans-Regular.ttf", 700: "noto-sans/NotoSans-Bold.ttf"},
    "noto-sans-jp": {400: "noto-sans-jp/NotoSansJP-Regular.ttf", 700: "noto-sans-jp/NotoSansJP-Bold.ttf"},
    "m-plus-rounded-1c": {400: "m-plus-rounded-1c/MPLUSRounded1c-Regular.ttf", 700: "m-plus-rounded-1c/MPLUSRounded1c-Bold.ttf"},
    "pacifico": {400: "pacifico/Pacifico-Regular.ttf"},
    "jetbrains-mono": {400: "jetbrains-mono/JetBrainsMono-Regular.ttf", 700: "jetbrains-mono/JetBrainsMono-Bold.ttf"},
}


def resolve_timeline_font_path(family_id: str, weight: int) -> Path:
    """Return absolute path to a bundled TTF; falls back to Inter Regular."""
    fam = _CATALOG.get(family_id) or _CATALOG["inter"]
    rel = fam.get(weight) or fam.get(400) or next(iter(fam.values()))
    path = (_FONTS_ROOT / rel).resolve()
    if path.is_file():
        return path
    # Any ttf in family folder
    fam_dir = _FONTS_ROOT / family_id
    if fam_dir.is_dir():
        for f in sorted(fam_dir.glob("*.ttf")):
            return f.resolve()
    inter = _FONTS_ROOT / "inter"
    if inter.is_dir():
        for f in sorted(inter.glob("*.ttf")):
            return f.resolve()
    raise FileNotFoundError(f"Timeline font not found: {family_id} weight={weight}")
