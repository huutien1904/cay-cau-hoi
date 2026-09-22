import * as THREE from 'three';

/*
 * Texture vẽ bằng Canvas 2D (trắng → trong suốt). Màu thật được nhân ở SpriteMaterial.color
 * nên cùng một texture dùng được cho mọi tông màu, và có thể đẩy màu lên HDR (> 1) để bloom.
 */

/** Vòng tròn mảnh — vòng chọn lá và sóng sáng khi trả lời. */
export function createRingTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.shadowColor = 'rgba(255,255,255,1)';
  ctx.shadowBlur = size * 0.04;
  ctx.lineWidth = size * 0.03;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = size * 0.012;
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([size * 0.04, size * 0.05]);
  ctx.beginPath();
  ctx.arc(c, c, size * 0.3, 0, Math.PI * 2);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
