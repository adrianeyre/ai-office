// Whether this browser can draw the 3D Office and the Avatar Editor's
// preview: both need WebGL 2. It loads no three.js. Tests replace it.

export const webgl = {
  available(): boolean {
    return typeof WebGL2RenderingContext !== "undefined";
  },
};
