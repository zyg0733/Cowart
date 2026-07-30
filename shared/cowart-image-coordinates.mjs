export class CowartCoordinateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CowartCoordinateError";
    this.code = code;
    this.details = details;
  }
}

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sizeOf = (shape, natural) => ({ w: num(shape?.props?.w, natural.width), h: num(shape?.props?.h, natural.height) });
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, point) => ({ x: m[0] * point.x + m[2] * point.y + m[4], y: m[1] * point.x + m[3] * point.y + m[5] });
const inverse = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new CowartCoordinateError("singular_transform", "Image transform cannot be inverted.");
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const transformForShape = (shape) => {
  const angle = num(shape?.rotation, 0);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return mul([1, 0, 0, 1, num(shape?.x, 0), num(shape?.y, 0)], [cos, sin, -sin, cos, 0, 0]);
};
const roundedBox = (box) => {
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.w);
  const y1 = Math.round(box.y + box.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const boxFromPoints = (points) => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
const corners = (box) => [
  { x: num(box?.x, 0), y: num(box?.y, 0) },
  { x: num(box?.x, 0) + num(box?.w, 0), y: num(box?.y, 0) },
  { x: num(box?.x, 0) + num(box?.w, 0), y: num(box?.y, 0) + num(box?.h, 0) },
  { x: num(box?.x, 0), y: num(box?.y, 0) + num(box?.h, 0) },
];
const normalizeCrop = (crop) => {
  if (!crop || typeof crop !== "object") return { x: 0, y: 0, w: 1, h: 1, schema: "default" };
  if (crop.topLeft && crop.bottomRight) {
    const x0 = clamp(num(crop.topLeft.x, 0), 0, 1);
    const y0 = clamp(num(crop.topLeft.y, 0), 0, 1);
    const x1 = clamp(num(crop.bottomRight.x, 1), 0, 1);
    const y1 = clamp(num(crop.bottomRight.y, 1), 0, 1);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, schema: "tldraw" };
  }
  throw new CowartCoordinateError("invalid_crop", "Image crop must use tldraw topLeft/bottomRight coordinates.", { crop });
};
const orientedQuadFromPoints = (points) => ({ kind: "oriented_quad", points });
const orientedQuadPoints = (quad) => {
  const value = Array.isArray(quad?.points) ? quad.points : null;
  if (!value) return null;
  if (value.length !== 4) throw new CowartCoordinateError("invalid_oriented_quad", "Oriented quadrilaterals must contain four points.", { points: value.length });
  return value.map((point) => ({ x: num(point?.x, 0), y: num(point?.y, 0) }));
};

export function createImageCoordinateMapper(contract) {
  const source = contract?.source ?? {};
  const shape = contract?.shape ?? {};
  const natural = { width: Math.round(num(source.width, 0)), height: Math.round(num(source.height, 0)) };
  const localSize = sizeOf(shape, natural);
  if (!(natural.width > 0 && natural.height > 0 && localSize.w > 0 && localSize.h > 0)) {
    throw new CowartCoordinateError("invalid_image_contract", "Image dimensions must be positive.", { natural, localSize });
  }
  const ancestors = Array.isArray(contract?.ancestors) ? contract.ancestors : [];
  const localToPage = ancestors.reduce((matrix, ancestor) => mul(transformForShape(ancestor), matrix), transformForShape(shape));
  const pageToLocal = inverse(localToPage);
  const cropBox = normalizeCrop(shape.props?.crop);
  if (!(cropBox.w > 0 && cropBox.h > 0)) throw new CowartCoordinateError("invalid_crop", "Crop dimensions must be positive.", { crop: cropBox });
  const flipX = shape.props?.flipX === true;
  const flipY = shape.props?.flipY === true;
  const sourceIdentity = {
    pageId: source.pageId,
    shapeId: source.shapeId,
    assetId: source.assetId,
    assetSha256: source.assetSha256,
    width: natural.width,
    height: natural.height,
  };
  const localPointToPagePoint = (point) => apply(localToPage, { x: num(point?.x, 0), y: num(point?.y, 0) });
  const pagePointToLocalPoint = (point) => apply(pageToLocal, { x: num(point?.x, 0), y: num(point?.y, 0) });
  const localPointToNaturalPoint = (point) => {
    const u0 = num(point?.x, 0) / localSize.w;
    const v0 = num(point?.y, 0) / localSize.h;
    let u = cropBox.x + u0 * cropBox.w;
    let v = cropBox.y + v0 * cropBox.h;
    if (flipX) u = 1 - u;
    if (flipY) v = 1 - v;
    return { x: u * natural.width, y: v * natural.height };
  };
  const naturalPointToLocalPoint = (point) => {
    let sourceU = num(point?.x, 0) / natural.width;
    let sourceV = num(point?.y, 0) / natural.height;
    if (flipX) sourceU = 1 - sourceU;
    if (flipY) sourceV = 1 - sourceV;
    const u = (sourceU - cropBox.x) / cropBox.w;
    const v = (sourceV - cropBox.y) / cropBox.h;
    return { x: u * localSize.w, y: v * localSize.h };
  };
  const pagePointToNaturalPoint = (point) => localPointToNaturalPoint(pagePointToLocalPoint(point));
  const naturalPointToPagePoint = (point) => localPointToPagePoint(naturalPointToLocalPoint(point));
  const mapBox = (box, mapper, round = false) => {
    const mapped = boxFromPoints(corners(box).map(mapper));
    return round ? roundedBox(mapped) : mapped;
  };
  const mapOrientedQuadToNaturalAabb = (quad, mapper) => {
    const mappedPoints = orientedQuadPoints(quad);
    if (!mappedPoints) throw new CowartCoordinateError("invalid_oriented_quad", "Expected an oriented quadrilateral with four points.");
    return roundedBox(boxFromPoints(mappedPoints.map(mapper)));
  };
  const naturalBoxToPageOrientedQuad = (box) => orientedQuadFromPoints(corners(box).map(naturalPointToPagePoint));
  return {
    sourceIdentity,
    naturalSize: natural,
    localSize,
    pagePointToLocalPoint,
    localPointToPagePoint,
    localPointToNaturalPoint,
    naturalPointToLocalPoint,
    pagePointToNaturalPoint,
    naturalPointToPagePoint,
    localAabbToNaturalAabb: (box) => mapBox(box, localPointToNaturalPoint),
    naturalBoxToLocalAabb: (box) => mapBox(box, naturalPointToLocalPoint),
    pageAabbToNaturalAabb: (box) => mapBox(box, pagePointToNaturalPoint, true),
    naturalBoxToPageAabb: (box) => boxFromPoints(corners(box).map(naturalPointToPagePoint)),
    pageOrientedQuadToNaturalAabb: (quad) => mapOrientedQuadToNaturalAabb(quad, pagePointToNaturalPoint),
    naturalBoxToPageOrientedQuad,
    localPolygonToNaturalPolygon: (polygon) => polygon.map(localPointToNaturalPoint),
    naturalPolygonToLocalPolygon: (polygon) => polygon.map(naturalPointToLocalPoint),
    pagePolygonToNaturalPolygon: (polygon) => polygon.map(pagePointToNaturalPoint),
    naturalPolygonToPagePolygon: (polygon) => polygon.map(naturalPointToPagePoint),
    pageAabbToNormalizedRoi(box) {
      const naturalBox = mapBox(box, pagePointToNaturalPoint);
      return {
        source: sourceIdentity,
        normalizedBox: {
          x: naturalBox.x / natural.width,
          y: naturalBox.y / natural.height,
          w: naturalBox.w / natural.width,
          h: naturalBox.h / natural.height,
        },
      };
    },
    normalizedRoiToNaturalAabb(roi) {
      const box = roi?.normalizedBox ?? {};
      return roundedBox({ x: num(box.x, 0) * natural.width, y: num(box.y, 0) * natural.height, w: num(box.w, 0) * natural.width, h: num(box.h, 0) * natural.height });
    },
  };
}
