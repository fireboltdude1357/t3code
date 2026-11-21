import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_PROMPT_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
} from "@t3tools/contracts";

export const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif';

// Some engines map `ui-monospace` to a proportional font, so prefer concrete names.
export const DEFAULT_CODE_FONT_STACK =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export const TYPOGRAPHY_ADVANCED_STORAGE_KEY = "t3code:typography-advanced";

export function resolveTerminalFontPreference(input: {
  readonly advanced: boolean;
  readonly code: string;
  readonly terminal: string;
}): string {
  if (input.advanced) return input.terminal;
  return input.code;
}

export function resolveTerminalFontSizePreference(input: {
  readonly advanced: boolean;
  readonly code: number;
  readonly terminal: number;
}): number {
  if (input.advanced) return input.terminal;
  return input.code;
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

export function appearanceFontStack(custom: string, defaultStack: string): string {
  const families = cssFontFamilies(custom);
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

export interface AppearanceFontPreferences {
  readonly sans: string;
  readonly code: string;
  readonly composer: string;
  readonly sizeInterface: number;
  readonly sizePrompt: number;
  readonly sizeCode: number;
  readonly smoothing: boolean;
  readonly separate: boolean;
}

/** Interface size sets the root; prompt and code use pixels to avoid double scaling. */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  // `measured` is the fallback as canvas can resolve it; null leaves the family uncentered.
  const families = [
    {
      variable: "--font-sans",
      custom: preferences.sans,
      fallback: DEFAULT_SANS_FONT_STACK,
      measured: DEFAULT_SANS_FONT_STACK,
    },
    {
      variable: "--font-mono",
      custom: preferences.code,
      fallback: DEFAULT_CODE_FONT_STACK,
      measured: null,
    },
    {
      variable: "--font-composer",
      custom: preferences.separate ? preferences.composer : "",
      fallback: "var(--font-sans)",
      measured: appearanceFontStack(preferences.sans, DEFAULT_SANS_FONT_STACK),
    },
  ] as const;
  for (const { variable, custom, fallback, measured } of families) {
    const list = cssFontFamilies(custom);
    const metrics = centeredMetricsFamily(
      variable,
      list === null || measured === null ? null : `${list}, ${measured}`,
    );
    if (list === null) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(
        variable,
        metrics === null ? `${list}, ${fallback}` : `${metrics}, ${list}, ${fallback}`,
      );
    }
  }

  const markerWidth = probeWidth(
    appearanceFontStack(preferences.sans, DEFAULT_SANS_FONT_STACK),
    LIST_MARKER_PROBE_TEXT,
  );
  if (markerWidth === null) {
    root.style.removeProperty("--list-marker-sans");
  } else {
    root.style.setProperty("--list-marker-sans", `${(markerWidth / PROBE_FONT_SIZE).toFixed(3)}em`);
  }

  root.style.fontSize = `${clampInterfaceFontSize(preferences.sizeInterface)}px`;
  root.style.setProperty(
    "--font-size-prompt",
    preferences.separate ? `${clampPromptFontSize(preferences.sizePrompt)}px` : "var(--text-sm)",
  );
  const code = clampCodeFontSize(preferences.sizeCode);
  root.style.setProperty("--font-size-code", `${code}px`);
  root.style.setProperty("--diffs-font-size", `${code}px`);

  if (preferences.smoothing) {
    root.style.setProperty("-webkit-font-smoothing", "antialiased");
  } else {
    root.style.removeProperty("-webkit-font-smoothing");
  }
}

function clampFontSize(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function clampInterfaceFontSize(value: number): number {
  return clampFontSize(
    value,
    MIN_INTERFACE_FONT_SIZE,
    MAX_INTERFACE_FONT_SIZE,
    DEFAULT_INTERFACE_FONT_SIZE,
  );
}

function clampPromptFontSize(value: number): number {
  return clampFontSize(value, MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE);
}

function clampCodeFontSize(value: number): number {
  return clampFontSize(value, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);
}

// A TrueType font with no glyphs but .notdef, built by fontTools FontBuilder with an empty cmap.
// First in a stack, it sets the line box while every glyph, space included, falls through.
const METRICS_FONT_BASE64 =
  "AAEAAAAKAIAAAwAgT1MvMkTfQZwAAAEoAAAAYGNtYXAADABGAAABjAAAACxnbHlmAAAAAAAAAbwAAAABaGVhZC1k4VQAAACsAAAANmhoZWEDIf86AAAA5AAAACRobXR4AAAAAAAAAYgAAAAEbG9jYQAAAAAAAAG4AAAABG1heHAAAgACAAABCAAAACBuYW1lYHiIugAAAcAAAABgcG9zdAADAAAAAAIgAAAAJAABAAAAAQAA+blHGF8PPPUAAwPoAAAAAOcnUDoAAAAA5ydQOgAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAABAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPz8/PwAAAAAAAAMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAgAAAAMAAAAUAAMAAQAAABQABAAYAAAAAgACAAAAAP//AAD//wABAAAAAAAAAAAAAAAAAAQANgABAAAAAAABAAcAAAABAAAAAAACAAcABwADAAEECQABAA4ADgADAAEECQACAA4AHE1ldHJpY3NSZWd1bGFyAE0AZQB0AHIAaQBjAHMAUgBlAGcAdQBsAGEAcgACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAA==";
// CSS `cap`, `ex` and `text-box` read these OS/2 fields (table at byte 296, 1000 units per em)
// from the first font, so each face carries the measured values.
const METRICS_FONT_UNITS_PER_EM = 1000;
const METRICS_FONT_X_HEIGHT_OFFSET = 296 + 86;
const METRICS_FONT_CAP_HEIGHT_OFFSET = 296 + 88;
const METRICS_PROBE_FONT_SIZE = 100;
// The face costs real ellipses (engines draw "...") and Firefox tab stops, so fonts whose
// capitals already sit this close to center go without it.
const METRICS_CENTERED_TOLERANCE_EM = 0.03;
const metricsFaces = new Map<string, { readonly face: FontFace; readonly key: string }>();

/**
 * Browsers place the baseline from a font's ascent and descent, so capitals sit off-center
 * in every control when those are unbalanced. This registers a metrics-only face that keeps
 * the line height and centers capitals, and returns its family name.
 */
function centeredMetricsFamily(variable: string, stack: string | null): string | null {
  const family = `t3-metrics${variable.slice("--font".length)}`;
  const metrics = stack === null ? null : measureCenteredMetrics(stack);
  const key = metrics === null ? null : Object.values(metrics).join(" ");
  const previous = metricsFaces.get(variable);
  if (previous?.key === key) return family;
  if (previous !== undefined) {
    document.fonts.delete(previous.face);
    metricsFaces.delete(variable);
  }
  if (metrics === null || key === null) return null;
  const data = Uint8Array.from(atob(METRICS_FONT_BASE64), (char) => char.charCodeAt(0));
  const view = new DataView(data.buffer);
  view.setInt16(METRICS_FONT_X_HEIGHT_OFFSET, metrics.xHeight);
  view.setInt16(METRICS_FONT_CAP_HEIGHT_OFFSET, metrics.capHeight);
  const percent = (units: number) => `${(units / METRICS_FONT_UNITS_PER_EM) * 100}%`;
  const face = new FontFace(family, data, {
    unicodeRange: "U+20",
    weight: "1 1000",
    ascentOverride: percent(metrics.ascent),
    descentOverride: percent(metrics.descent),
    lineGapOverride: "0%",
  });
  document.fonts.add(face);
  metricsFaces.set(variable, { face, key });
  return family;
}

/** Font-unit metrics that keep the stack's line height and put its capitals at the center. */
function measureCenteredMetrics(stack: string) {
  // Without the overrides the face would apply its own placeholder metrics (Safari before 27.3).
  if (typeof FontFace === "undefined" || !("ascentOverride" in FontFace.prototype)) return null;
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `${METRICS_PROBE_FONT_SIZE}px ${stack}`;
  const capitals = fontProbeContext.measureText("H");
  const height = capitals.fontBoundingBoxAscent + capitals.fontBoundingBoxDescent;
  const cap = capitals.actualBoundingBoxAscent;
  if (!(height > cap && cap > 0)) return null;
  const offset = capitals.fontBoundingBoxAscent - capitals.fontBoundingBoxDescent - cap;
  if (Math.abs(offset / 2 / METRICS_PROBE_FONT_SIZE) < METRICS_CENTERED_TOLERANCE_EM) return null;
  const units = (pixels: number) =>
    Math.round((pixels / METRICS_PROBE_FONT_SIZE) * METRICS_FONT_UNITS_PER_EM);
  return {
    ascent: units((height + cap) / 2),
    descent: units((height - cap) / 2),
    capHeight: units(cap),
    xHeight: units(fontProbeContext.measureText("x").actualBoundingBoxAscent),
  };
}

const FONT_PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";
// The widest single-digit `ol` marker; CSS can't measure it to size the list gutter.
const LIST_MARKER_PROBE_TEXT = "0. ";
const PROBE_FONT_SIZE = 16;
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string, text = FONT_PROBE_TEXT): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `${PROBE_FONT_SIZE}px ${fontList}`;
  return fontProbeContext.measureText(text).width;
}

const LATIN_PROBE_TEXT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * False when any Latin letter falls back past the first family, as in Arabic-only faces like
 * Al Tarikh. Later families in a typed list don't count, since the first one draws the digits.
 */
export function hasAllLatinLetters(family: string): boolean {
  const first = cssFontFamilies(family.split(",")[0] ?? "");
  if (first === null) return true;
  const serif = probeWidth(`${first}, serif`, LATIN_PROBE_TEXT);
  const monospace = probeWidth(`${first}, monospace`, LATIN_PROBE_TEXT);
  return serif === null || monospace === null || serif === monospace;
}

/** Probes canvas metrics because document.fonts.check() accepts uninstalled families. */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true;
  try {
    for (const generic of ["monospace", "serif", "sans-serif"]) {
      const baseline = probeWidth(generic);
      const candidate = probeWidth(`${families}, ${generic}`);
      if (baseline === null || candidate === null) return false;
      if (candidate !== baseline) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

const SANS_GENERIC_CANDIDATES = [
  "Segoe UI",
  "Roboto",
  "Noto Sans",
  "Ubuntu",
  "Cantarell",
  "DejaVu Sans",
  "Liberation Sans",
  "Helvetica Neue",
  "Arial",
] as const;
const MONO_GENERIC_CANDIDATES = [
  "Menlo",
  "Consolas",
  "Cascadia Mono",
  "DejaVu Sans Mono",
  "Ubuntu Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Roboto Mono",
  "Monaco",
  "Courier New",
] as const;

const GENERIC_PROBE_TEXT = "RagIl10O@ fjord quiz";

// Canvas generic-family mappings can differ from CSS, so measure the DOM.
function measureDomProbeWidth(fontFamily: string): number | null {
  try {
    const body = document.body;
    if (!body) return null;
    const span = document.createElement("span");
    span.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px;";
    span.style.fontFamily = fontFamily;
    span.textContent = GENERIC_PROBE_TEXT;
    body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width > 0 ? width : null;
  } catch {
    return null;
  }
}

function widthsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

function resolveGenericFamilyLabel(generic: string): string | null {
  const lower = generic.toLowerCase();
  if (lower === "serif") return null;
  const monoLike = lower === "ui-monospace" || lower === "monospace";
  const genericWidth = measureDomProbeWidth(generic);
  if (genericWidth === null) return null;
  for (const candidate of monoLike ? MONO_GENERIC_CANDIDATES : SANS_GENERIC_CANDIDATES) {
    if (!isFontFamilyAvailable(candidate)) continue;
    const candidateWidth = measureDomProbeWidth(`"${candidate}"`);
    if (candidateWidth !== null && widthsMatch(genericWidth, candidateWidth)) {
      return candidate;
    }
  }
  // Unnameable Apple faces need -apple-system metrics to distinguish the UI face from SF Mono.
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform)) {
    const systemWidth = measureDomProbeWidth("-apple-system");
    if (systemWidth !== null && widthsMatch(genericWidth, systemWidth)) return "SF Pro";
    return monoLike ? "SF Mono" : "SF Pro";
  }
  return null;
}

// Synthetic Apple labels are not necessarily available as named CSS families.
export function displayFontFamily(family: string): string {
  const label = family
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim()
    .toLowerCase();
  if (label === "sf pro") return appearanceFontStack(family, DEFAULT_SANS_FONT_STACK);
  if (label === "sf mono") return DEFAULT_CODE_FONT_STACK;
  return cssFontFamilies(family) ?? "";
}

export function resolveDefaultFamilyLabel(stack: string): string | null {
  for (const raw of stack.split(",")) {
    const family = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (family.length === 0) continue;
    if (
      /^(system-ui|sans-serif|serif|monospace|ui-monospace|-apple-system|BlinkMacSystemFont)$/i.test(
        family,
      )
    ) {
      const resolved = resolveGenericFamilyLabel(family);
      if (resolved !== null) return resolved;
      continue;
    }
    if (isFontFamilyAvailable(family)) return family;
  }
  return null;
}

export interface InstalledFontFamiliesResult {
  readonly families: readonly string[];
  readonly status: "granted" | "denied" | "unsupported";
}

let installedFamiliesCache: InstalledFontFamiliesResult | null = null;

/** Call from a user gesture; the first call prompts for local-fonts permission. */
export async function queryInstalledFontFamilies(): Promise<InstalledFontFamiliesResult> {
  if (installedFamiliesCache !== null) return installedFamiliesCache;
  const query = (
    window as Window & {
      queryLocalFonts?: () => Promise<ReadonlyArray<{ readonly family: string }>>;
    }
  ).queryLocalFonts;
  if (typeof query !== "function") {
    installedFamiliesCache = { families: [], status: "unsupported" };
    return installedFamiliesCache;
  }
  try {
    const fonts = await query.call(window);
    const families = [...new Set(fonts.map((font) => font.family))]
      // Dot-prefixed macOS UI faces often refuse to render in web content.
      .filter((family) => !family.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    // Denied access can return an empty list instead of throwing.
    if (families.length === 0) return { families: [], status: "denied" };
    installedFamiliesCache = { families, status: "granted" };
    return installedFamiliesCache;
  } catch {
    return { families: [], status: "denied" };
  }
}
