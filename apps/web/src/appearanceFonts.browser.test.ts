import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceFontVariables, hasAllLatinLetters } from "./appearanceFonts";
import symbolsFontUrl from "./terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2?url";

// A face with no Latin letters and a deep descent, like Al Tarikh on macOS.
async function loadLopsidedSymbolsFont(family: string): Promise<FontFace> {
  const data = await fetch(symbolsFontUrl).then((response) => response.arrayBuffer());
  const face = new FontFace(family, data, { ascentOverride: "50%", descentOverride: "90%" });
  document.fonts.add(await face.load());
  return face;
}

const interfacePreferences = {
  code: "",
  composer: "",
  sizeInterface: 16,
  sizePrompt: 14,
  sizeCode: 13,
  smoothing: true,
  separate: false,
};

function renderedFontSize(style: (probe: HTMLElement) => void): string {
  const probe = document.createElement("div");
  style(probe);
  document.body.append(probe);
  try {
    return getComputedStyle(probe).fontSize;
  } finally {
    probe.remove();
  }
}

const composerFontSize = () =>
  renderedFontSize((probe) => {
    // The composer editor's own size class.
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  });

const touchComposerFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  });

describe("applyAppearanceFontVariables", () => {
  it("sizes the composer from the interface size until fonts are set separately", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      sizeInterface: 20,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
    };
    try {
      applyAppearanceFontVariables(root, { ...preferences, separate: false });
      expect(composerFontSize()).toBe("17.5px");
      expect(touchComposerFontSize()).toBe("17.5px");

      applyAppearanceFontVariables(root, { ...preferences, separate: true });
      expect(composerFontSize()).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("widens the numbered-list gutter only when the interface font's marker would clip", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const gutter = (sans: string) => {
      applyAppearanceFontVariables(root, {
        sans,
        code: "",
        composer: "",
        sizeInterface: 16,
        sizePrompt: 14,
        sizeCode: 13,
        smoothing: true,
        separate: false,
      });
      const markdown = document.createElement("div");
      markdown.className = "chat-markdown";
      markdown.style.fontSize = "14px";
      const list = document.createElement("ol");
      markdown.append(list);
      document.body.append(markdown);
      try {
        return Number.parseFloat(getComputedStyle(list).paddingInlineStart);
      } finally {
        markdown.remove();
      }
    };
    try {
      // `0. ` in a 14px monospace font is about 25px, past the 20px default.
      expect(gutter("monospace")).toBeGreaterThan(24);
      expect(gutter("sans-serif")).toBe(20);
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("centers capitals in a control when the interface font's ascent and descent are unbalanced", async () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const face = await loadLopsidedSymbolsFont("Lopsided Symbols");
    const control = document.createElement("div");
    control.style.cssText =
      "display:flex;align-items:center;height:40px;font-family:var(--font-sans);font-size:20px;line-height:20px";
    control.innerHTML = '<span>H<i style="display:inline-block;width:0;height:0"></i></span>';
    try {
      applyAppearanceFontVariables(root, { ...interfacePreferences, sans: "Lopsided Symbols" });
      await document.fonts.ready;
      document.body.append(control);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `20px ${getComputedStyle(control).fontFamily}`;
      const capHeight = context.measureText("H").actualBoundingBoxAscent;
      const baseline = control.querySelector("i")!.getBoundingClientRect().top;
      const box = control.getBoundingClientRect();
      expect(Math.abs(baseline - capHeight / 2 - (box.top + box.height / 2))).toBeLessThan(0.5);
    } finally {
      control.remove();
      document.fonts.delete(face);
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});

describe("hasAllLatinLetters", () => {
  it("rejects a face whose Latin letters fall back to another font", async () => {
    const face = await loadLopsidedSymbolsFont("Symbols Only");
    try {
      expect(hasAllLatinLetters("Symbols Only")).toBe(false);
      expect(hasAllLatinLetters("sans-serif")).toBe(true);
    } finally {
      document.fonts.delete(face);
    }
  });
});
