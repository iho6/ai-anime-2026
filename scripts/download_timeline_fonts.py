#!/usr/bin/env python3
"""Download timeline font files from Google Fonts GitHub (OFL licensed)."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "ui" / "frontend" / "public" / "fonts"
GF_RAW = "https://raw.githubusercontent.com/google/fonts/main"

# family_dir -> [(weight, github_subpath_regular, github_subpath_bold_or_none)]
FAMILIES: dict[str, list[tuple[int, str, str | None]]] = {
    "inter": [(400, "ofl/inter/Inter%5Bwght%5D.ttf", None)],
    "roboto": [
        (400, "apache/roboto/Roboto-Regular.ttf", None),
        (700, "apache/roboto/Roboto-Bold.ttf", None),
    ],
    "open-sans": [
        (400, "ofl/opensans/OpenSans%5Bwdth,wght%5D.ttf", None),
    ],
    "lato": [
        (400, "ofl/lato/Lato-Regular.ttf", None),
        (700, "ofl/lato/Lato-Bold.ttf", None),
    ],
    "montserrat": [(400, "ofl/montserrat/Montserrat%5Bwght%5D.ttf", None)],
    "raleway": [(400, "ofl/raleway/Raleway%5Bwght%5D.ttf", None)],
    "poppins": [
        (400, "ofl/poppins/Poppins-Regular.ttf", None),
        (700, "ofl/poppins/Poppins-Bold.ttf", None),
    ],
    "nunito": [(400, "ofl/nunito/Nunito%5Bwght%5D.ttf", None)],
    "source-sans-3": [(400, "ofl/sourcesans3/SourceSans3%5Bwght%5D.ttf", None)],
    "ubuntu": [
        (400, "ufl/ubuntu/Ubuntu-Regular.ttf", None),
        (700, "ufl/ubuntu/Ubuntu-Bold.ttf", None),
    ],
    "rubik": [(400, "ofl/rubik/Rubik%5Bwght%5D.ttf", None)],
    "oswald": [(400, "ofl/oswald/Oswald%5Bwght%5D.ttf", None)],
    "bebas-neue": [(400, "ofl/bebasneue/BebasNeue-Regular.ttf", None)],
    "playfair-display": [
        (400, "ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf", None),
    ],
    "merriweather": [(400, "ofl/merriweather/Merriweather%5Bwght%5D.ttf", None)],
    "noto-sans": [(400, "ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf", None)],
    "noto-sans-jp": [(400, "ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf", None)],
    "m-plus-rounded-1c": [(400, "ofl/mplusrounded1c/MPLUSRounded1c%5Bwght%5D.ttf", None)],
    "pacifico": [(400, "ofl/pacifico/Pacifico-Regular.ttf", None)],
    "jetbrains-mono": [(400, "ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf", None)],
}

# Map catalog file names (from timelineFonts.ts) to downloaded ttf
NAME_MAP: dict[str, str] = {
    "inter/Inter-Regular": "inter/Inter-Regular.ttf",
    "inter/Inter-Bold": "inter/Inter-Bold.ttf",
    "roboto/Roboto-Regular": "roboto/Roboto-Regular.ttf",
    "roboto/Roboto-Bold": "roboto/Roboto-Bold.ttf",
    "open-sans/OpenSans-Regular": "open-sans/OpenSans-Regular.ttf",
    "open-sans/OpenSans-Bold": "open-sans/OpenSans-Bold.ttf",
    "lato/Lato-Regular": "lato/Lato-Regular.ttf",
    "lato/Lato-Bold": "lato/Lato-Bold.ttf",
    "montserrat/Montserrat-Regular": "montserrat/Montserrat-Regular.ttf",
    "montserrat/Montserrat-Bold": "montserrat/Montserrat-Bold.ttf",
    "raleway/Raleway-Regular": "raleway/Raleway-Regular.ttf",
    "raleway/Raleway-Bold": "raleway/Raleway-Bold.ttf",
    "poppins/Poppins-Regular": "poppins/Poppins-Regular.ttf",
    "poppins/Poppins-Bold": "poppins/Poppins-Bold.ttf",
    "nunito/Nunito-Regular": "nunito/Nunito-Regular.ttf",
    "nunito/Nunito-Bold": "nunito/Nunito-Bold.ttf",
    "source-sans-3/SourceSans3-Regular": "source-sans-3/SourceSans3-Regular.ttf",
    "source-sans-3/SourceSans3-Bold": "source-sans-3/SourceSans3-Bold.ttf",
    "ubuntu/Ubuntu-Regular": "ubuntu/Ubuntu-Regular.ttf",
    "ubuntu/Ubuntu-Bold": "ubuntu/Ubuntu-Bold.ttf",
    "rubik/Rubik-Regular": "rubik/Rubik-Regular.ttf",
    "rubik/Rubik-Bold": "rubik/Rubik-Bold.ttf",
    "oswald/Oswald-Regular": "oswald/Oswald-Regular.ttf",
    "oswald/Oswald-Bold": "oswald/Oswald-Bold.ttf",
    "bebas-neue/BebasNeue-Regular": "bebas-neue/BebasNeue-Regular.ttf",
    "playfair-display/PlayfairDisplay-Regular": "playfair-display/PlayfairDisplay-Regular.ttf",
    "playfair-display/PlayfairDisplay-Bold": "playfair-display/PlayfairDisplay-Bold.ttf",
    "merriweather/Merriweather-Regular": "merriweather/Merriweather-Regular.ttf",
    "merriweather/Merriweather-Bold": "merriweather/Merriweather-Bold.ttf",
    "noto-sans/NotoSans-Regular": "noto-sans/NotoSans-Regular.ttf",
    "noto-sans/NotoSans-Bold": "noto-sans/NotoSans-Bold.ttf",
    "noto-sans-jp/NotoSansJP-Regular": "noto-sans-jp/NotoSansJP-Regular.ttf",
    "noto-sans-jp/NotoSansJP-Bold": "noto-sans-jp/NotoSansJP-Bold.ttf",
    "m-plus-rounded-1c/MPLUSRounded1c-Regular": "m-plus-rounded-1c/MPLUSRounded1c-Regular.ttf",
    "m-plus-rounded-1c/MPLUSRounded1c-Bold": "m-plus-rounded-1c/MPLUSRounded1c-Bold.ttf",
    "pacifico/Pacifico-Regular": "pacifico/Pacifico-Regular.ttf",
    "jetbrains-mono/JetBrainsMono-Regular": "jetbrains-mono/JetBrainsMono-Regular.ttf",
    "jetbrains-mono/JetBrainsMono-Bold": "jetbrains-mono/JetBrainsMono-Bold.ttf",
}


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 1000:
        print(f"skip {dest.name}")
        return
    print(f"fetch {url}")
    urllib.request.urlretrieve(url, dest)


def main() -> None:
    manifest: dict[str, str] = {}
    for fam, entries in FAMILIES.items():
        for weight, path, _ in entries:
            url = f"{GF_RAW}/{path}"
            ttf_name = path.split("/")[-1].replace("%5B", "[").replace("%5D", "]")
            dest = OUT / fam / ttf_name
            try:
                download(url, dest)
            except Exception as e:
                print(f"warn {fam}: {e}")
            # symlink-style copies for catalog names
            for catalog_key, rel in NAME_MAP.items():
                if rel.startswith(f"{fam}/") and str(weight) in ("400", "700"):
                    if weight == 400 and "Regular" in catalog_key:
                        target = OUT / f"{catalog_key}.ttf"
                        if dest.is_file():
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(dest.read_bytes())
                            manifest[catalog_key] = str(target.relative_to(OUT))
                    if weight == 700 and "Bold" in catalog_key:
                        target = OUT / f"{catalog_key}.ttf"
                        if dest.is_file():
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(dest.read_bytes())

    # Variable fonts: copy same file for bold where only one file exists
    for catalog_key, rel in NAME_MAP.items():
        ttf = OUT / f"{catalog_key}.ttf"
        if not ttf.is_file():
            reg = OUT / catalog_key.split("/")[0]
            if reg.is_dir():
                for f in reg.glob("*.ttf"):
                    ttf.parent.mkdir(parents=True, exist_ok=True)
                    ttf.write_bytes(f.read_bytes())
                    break

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("done")


if __name__ == "__main__":
    main()
