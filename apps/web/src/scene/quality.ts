// The 3D Office's quality settings (PRD §7, Performance): Low, Medium and
// High, as docs/reference/art-direction.md sets them out. Each one says how
// the key light casts shadows, which post-processing effects run and how
// many device pixels the canvas may use. Medium is the one that must hold
// 60 fps at 1080p on a 2022-era laptop with an integrated GPU.

export const qualityLevels = ["low", "medium", "high"] as const;
export type QualityLevel = (typeof qualityLevels)[number];

export interface QualityPreset {
  readonly label: string;
  /**
   * The key light's real-time shadows, or none (Low, which has only the
   * baked contact shadows). `radius` is the penumbra's softness, in shadow
   * map texels.
   */
  readonly shadows:
    { readonly mapSize: number; readonly radius: number } | undefined;
  /** Where baked contact shadows (a soft blob, `shadow` at 35%) are drawn. */
  readonly contactShadows: {
    /** Under each desk and chair. */
    readonly props: boolean;
    /** Under each Agent. */
    readonly agents: boolean;
  };
  /** Device pixels per CSS pixel, at most; never more than the screen has. */
  readonly maxPixelRatio: number;
  /** The largest texture drawn, in pixels along its longer side. */
  readonly largestTexture: number;
  /**
   * Post-processing. Tone mapping and colour grading run at every setting,
   * so they are not here.
   */
  readonly postProcessing: {
    /** N8AO ambient occlusion: off (baked only), at half or full resolution. */
    readonly ambientOcclusion: "off" | "half" | "full";
    readonly bloom: boolean;
    readonly vignette: boolean;
    readonly smaa: boolean;
    /** The composer's MSAA samples; 0 for none. */
    readonly multisampling: number;
  };
}

export const qualityPresets: Readonly<Record<QualityLevel, QualityPreset>> = {
  low: {
    label: "Low",
    shadows: undefined,
    contactShadows: { props: true, agents: true },
    maxPixelRatio: 1,
    largestTexture: 512,
    postProcessing: {
      ambientOcclusion: "off",
      bloom: false,
      vignette: false,
      smaa: false,
      multisampling: 0,
    },
  },
  medium: {
    label: "Medium",
    shadows: { mapSize: 1024, radius: 4 },
    contactShadows: { props: false, agents: false },
    maxPixelRatio: 1.5,
    largestTexture: 1024,
    postProcessing: {
      ambientOcclusion: "half",
      bloom: true,
      vignette: true,
      smaa: true,
      multisampling: 0,
    },
  },
  high: {
    label: "High",
    shadows: { mapSize: 2048, radius: 6 },
    contactShadows: { props: false, agents: true },
    maxPixelRatio: 2,
    largestTexture: 2048,
    postProcessing: {
      ambientOcclusion: "full",
      bloom: true,
      vignette: true,
      smaa: true,
      multisampling: 4,
    },
  },
};

/** The setting a browser starts on: the one the performance target is for. */
export const defaultQuality: QualityLevel = "medium";

export function isQualityLevel(value: unknown): value is QualityLevel {
  return qualityLevels.some((level) => level === value);
}

/**
 * The canvas's pixel ratio range for React Three Fiber's `dpr`: the
 * screen's own ratio, but no less than 1 and no more than the preset allows.
 */
export function canvasDpr(preset: QualityPreset): [number, number] {
  return [1, preset.maxPixelRatio];
}
