export type TimelineFontVariant = {
  weight: number;
  style: "normal";
  woff2: string;
  ttf: string;
};

export type TimelineFontFamily = {
  id: string;
  label: string;
  category: string;
  variants: TimelineFontVariant[];
};

function v(weight: number, file: string): TimelineFontVariant {
  const ttf = `/fonts/${file}.ttf`;
  return {
    weight,
    style: "normal",
    woff2: ttf,
    ttf,
  };
}

/** Curated timeline font catalog (~20 families, Regular + Bold). */
export const TIMELINE_FONTS: TimelineFontFamily[] = [
  { id: "inter", label: "Inter", category: "Sans", variants: [v(400, "inter/Inter-Regular"), v(700, "inter/Inter-Bold")] },
  { id: "roboto", label: "Roboto", category: "Sans", variants: [v(400, "roboto/Roboto-Regular"), v(700, "roboto/Roboto-Bold")] },
  { id: "open-sans", label: "Open Sans", category: "Sans", variants: [v(400, "open-sans/OpenSans-Regular"), v(700, "open-sans/OpenSans-Bold")] },
  { id: "lato", label: "Lato", category: "Sans", variants: [v(400, "lato/Lato-Regular"), v(700, "lato/Lato-Bold")] },
  { id: "montserrat", label: "Montserrat", category: "Sans", variants: [v(400, "montserrat/Montserrat-Regular"), v(700, "montserrat/Montserrat-Bold")] },
  { id: "raleway", label: "Raleway", category: "Sans", variants: [v(400, "raleway/Raleway-Regular"), v(700, "raleway/Raleway-Bold")] },
  { id: "poppins", label: "Poppins", category: "Sans", variants: [v(400, "poppins/Poppins-Regular"), v(700, "poppins/Poppins-Bold")] },
  { id: "nunito", label: "Nunito", category: "Sans", variants: [v(400, "nunito/Nunito-Regular"), v(700, "nunito/Nunito-Bold")] },
  { id: "source-sans-3", label: "Source Sans 3", category: "Sans", variants: [v(400, "source-sans-3/SourceSans3-Regular"), v(700, "source-sans-3/SourceSans3-Bold")] },
  { id: "ubuntu", label: "Ubuntu", category: "Sans", variants: [v(400, "ubuntu/Ubuntu-Regular"), v(700, "ubuntu/Ubuntu-Bold")] },
  { id: "rubik", label: "Rubik", category: "Sans", variants: [v(400, "rubik/Rubik-Regular"), v(700, "rubik/Rubik-Bold")] },
  { id: "oswald", label: "Oswald", category: "Display", variants: [v(400, "oswald/Oswald-Regular"), v(700, "oswald/Oswald-Bold")] },
  { id: "bebas-neue", label: "Bebas Neue", category: "Display", variants: [v(400, "bebas-neue/BebasNeue-Regular")] },
  { id: "playfair-display", label: "Playfair Display", category: "Serif", variants: [v(400, "playfair-display/PlayfairDisplay-Regular"), v(700, "playfair-display/PlayfairDisplay-Bold")] },
  { id: "merriweather", label: "Merriweather", category: "Serif", variants: [v(400, "merriweather/Merriweather-Regular"), v(700, "merriweather/Merriweather-Bold")] },
  { id: "noto-sans", label: "Noto Sans", category: "Sans", variants: [v(400, "noto-sans/NotoSans-Regular"), v(700, "noto-sans/NotoSans-Bold")] },
  { id: "noto-sans-jp", label: "Noto Sans JP", category: "Japanese", variants: [v(400, "noto-sans-jp/NotoSansJP-Regular"), v(700, "noto-sans-jp/NotoSansJP-Bold")] },
  { id: "m-plus-rounded-1c", label: "M PLUS Rounded 1c", category: "Japanese", variants: [v(400, "m-plus-rounded-1c/MPLUSRounded1c-Regular"), v(700, "m-plus-rounded-1c/MPLUSRounded1c-Bold")] },
  { id: "pacifico", label: "Pacifico", category: "Script", variants: [v(400, "pacifico/Pacifico-Regular")] },
  { id: "jetbrains-mono", label: "JetBrains Mono", category: "Mono", variants: [v(400, "jetbrains-mono/JetBrainsMono-Regular"), v(700, "jetbrains-mono/JetBrainsMono-Bold")] },
];

export function findTimelineFont(familyId: string): TimelineFontFamily | undefined {
  return TIMELINE_FONTS.find((f) => f.id === familyId);
}

export function timelineFontCssFamily(familyId: string): string {
  return `TimelineFont_${familyId.replace(/-/g, "_")}`;
}

const loaded = new Set<string>();

/** Lazy-load a font variant for preview via FontFace API. */
export async function ensureTimelineFontLoaded(
  familyId: string,
  weight: number
): Promise<string> {
  const family = findTimelineFont(familyId) ?? TIMELINE_FONTS[0];
  const variant =
    family.variants.find((x) => x.weight === weight) ?? family.variants[0];
  const cssFamily = timelineFontCssFamily(family.id);
  const key = `${cssFamily}-${variant.weight}`;
  if (loaded.has(key)) return cssFamily;

  try {
    const src = variant.woff2;
    const face = new FontFace(cssFamily, `url(${src}), url(${variant.ttf})`, {
      weight: String(variant.weight),
      style: variant.style,
    });
    await face.load();
    document.fonts.add(face);
    loaded.add(key);
  } catch {
    try {
      const face = new FontFace(cssFamily, `url(${variant.ttf})`, {
        weight: String(variant.weight),
        style: variant.style,
      });
      await face.load();
      document.fonts.add(face);
      loaded.add(key);
    } catch {
      /* fallback to sans-serif */
    }
  }
  return cssFamily;
}
