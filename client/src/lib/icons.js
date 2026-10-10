// Weather signs are drawn once as signed-distance-field icons so MapLibre can tint each one per feature (`icon-color`).
const SIZE = 64;
const RADIUS = 8;
const CUTOFF = 0.25;
const INF = 1e20;

const SHAPES = {
  // Rounded badge that carries the value text (temperature).
  badge: (ctx, c) => { ctx.beginPath(); ctx.arc(c, c, 23, 0, Math.PI * 2); ctx.fill(); },
  // Tiny neutral marker for "nothing to report" so the map never looks empty or calm by accident.
  dot: (ctx, c) => { ctx.beginPath(); ctx.arc(c, c, 6, 0, Math.PI * 2); ctx.fill(); },
  drop: (ctx, c) => {
    ctx.beginPath();
    ctx.moveTo(c, c - 24);
    ctx.bezierCurveTo(c + 6, c - 12, c + 17, c - 2, c + 17, c + 8);
    ctx.arc(c, c + 8, 17, 0, Math.PI, false);
    ctx.bezierCurveTo(c - 17, c - 2, c - 6, c - 12, c, c - 24);
    ctx.fill();
  },
  sun: (ctx, c) => {
    ctx.beginPath(); ctx.arc(c, c, 11, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 4.5; ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * 17, c + Math.sin(a) * 17);
      ctx.lineTo(c + Math.cos(a) * 24, c + Math.sin(a) * 24);
      ctx.stroke();
    }
  },
  bolt: (ctx, c) => {
    ctx.beginPath();
    [[5, -25], [-13, 3], [-2, 3], [-7, 25], [13, -7], [2, -7]].forEach(([x, y], i) => (i ? ctx.lineTo(c + x, c + y) : ctx.moveTo(c + x, c + y)));
    ctx.closePath(); ctx.fill();
  },
  // Points up; rotated with `icon-rotate` to the direction the wind blows toward.
  arrow: (ctx, c) => {
    ctx.beginPath();
    [[0, -25], [16, 21], [0, 11], [-16, 21]].forEach(([x, y], i) => (i ? ctx.lineTo(c + x, c + y) : ctx.moveTo(c + x, c + y)));
    ctx.closePath(); ctx.fill();
  },
};

function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0; z[0] = -INF; z[1] = INF; f[0] = grid[offset];

  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }

  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt(grid, width, height, f, v, z) {
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

// Same encoding as @mapbox/tiny-sdf: edge at alpha 0.75, inside brighter, outside darker.
function toSdf(alpha) {
  const length = SIZE * SIZE;
  const outer = new Float64Array(length);
  const inner = new Float64Array(length);
  const f = new Float64Array(SIZE);
  const v = new Uint16Array(SIZE);
  const z = new Float64Array(SIZE + 1);

  for (let i = 0; i < length; i++) {
    const a = alpha[i] / 255;
    outer[i] = a === 1 ? 0 : a === 0 ? INF : (0.5 - a > 0 ? (0.5 - a) ** 2 : 0);
    inner[i] = a === 1 ? INF : a === 0 ? 0 : (a - 0.5 > 0 ? (a - 0.5) ** 2 : 0);
  }

  edt(outer, SIZE, SIZE, f, v, z);
  edt(inner, SIZE, SIZE, f, v, z);

  const data = new Uint8ClampedArray(length * 4);
  for (let i = 0; i < length; i++) {
    const distance = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(255 - 255 * (distance / RADIUS + CUTOFF))));
  }
  return data;
}

export function registerIcons(map) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  for (const [name, draw] of Object.entries(SHAPES)) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    draw(ctx, SIZE / 2);

    const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const alpha = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];

    if (map.hasImage(name)) map.removeImage(name);
    map.addImage(name, { width: SIZE, height: SIZE, data: toSdf(alpha) }, { sdf: true, pixelRatio: 2 });
  }
}

