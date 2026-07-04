// Category colors shared by the 3D universe and the DOM overlays (filter
// chips). No three.js dependency: the main chunk must stay lazy-load clean.
const CAT_COLORS: Record<string, string> = {
  'dishwasher': '#59c2ff',
  'washing machine': '#6e9cff',
  'vehicle': '#a3d977',
  'smartphone': '#c792ea',
  'game console': '#f07178',
  'coffee machine': '#e6b455',
};

/** Fixed hues for the core categories; deterministic generated hues for the rest. */
export const catColor = (label: string) => {
  const key = label.toLowerCase();
  if (CAT_COLORS[key]) return CAT_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, ${62 + (h % 3) * 8}%, ${64 + (h % 4) * 4}%)`;
};
