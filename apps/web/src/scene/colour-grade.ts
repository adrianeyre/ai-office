import { palette } from "@ai-office/shared/palette";
import { Effect } from "postprocessing";
import { Color, Uniform } from "three";

// The part of the colour grade postprocessing has no effect for
// (docs/reference/art-direction.md, "Post-processing"): it lifts the shadows
// towards the palette's `shadow` and warms the highlights a little towards
// the key light's `light-key`. It runs after tone mapping, on colours in
// 0 to 1, and is gentle enough that no token looks different in 3D than in
// 2D. HueSaturation and BrightnessContrast do the rest of the grade.

const fragmentShader = /* glsl */ `
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform float shadowLift;
uniform float highlightWarmth;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float luma = dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(inputColor.rgb, shadowTint, shadowLift * (1.0 - smoothstep(0.0, 0.5, luma)));
  graded = mix(graded, graded * highlightTint, highlightWarmth * smoothstep(0.5, 1.0, luma));
  outputColor = vec4(graded, inputColor.a);
}
`;

/** How far the darkest shadows move towards `shadow`, from 0 to 1. */
export const shadowLift = 0.2;
/** How far the brightest highlights are tinted by `light-key`, from 0 to 1. */
export const highlightWarmth = 0.1;

export class ColourGradeEffect extends Effect {
  constructor() {
    super("ColourGradeEffect", fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ["shadowTint", new Uniform(new Color(palette.shadow))],
        ["highlightTint", new Uniform(new Color(palette["light-key"]))],
        ["shadowLift", new Uniform(shadowLift)],
        ["highlightWarmth", new Uniform(highlightWarmth)],
      ]),
    });
  }
}
