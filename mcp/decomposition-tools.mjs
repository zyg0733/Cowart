import { readFile } from "node:fs/promises";

import { COWART_AI_IMAGE_SHAPE } from "./constants.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { getRecord, loadCanvasSnapshot, persistRecords } from "./canvas-client.mjs";
import { chooseIndex, choosePlacement } from "./geometry.mjs";
import { currentSourceIdentity } from "./object-aware-deps.mjs";
import { segmentStoreForArgs, segmentSummary, validateSegmentSource } from "./object-aware-segments.mjs";
import { currentHolderRequest, makeCowartRequest, archiveRequest } from "./request-lifecycle.mjs";
import { finiteNumber, nonEmptyString, sanitizeIdPart, uniqueRecordId } from "./paths.mjs";
import { extractMaskedObject } from "./image-composite.mjs";
import { hashBuffer, sourceCondition } from "./object-aware-source.mjs";

export const DECOMPOSITION_ARTIFACT_KINDS = Object.freeze([
  "depth_hint",
  "clean_plate",
  "visible_object_layer",
  "completed_object",
  "composite",
]);

function newDecompositionId() {
  return `decomposition:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function publicSource(source) {
  return {
    pageId: source.pageId,
    shapeId: source.shapeId,
    assetId: source.assetId,
    assetSha256: source.assetSha256,
    width: source.width,
    height: source.height,
  };
}

function decompositionForStore(store, decompositionId) {
  return Object.values(store).find(
    (record) =>
      record?.typeName === "shape" &&
      record.meta?.cowartDecomposition?.id === decompositionId
  );
}

function summary(manifest, holderId) {
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  return {
    id: manifest?.id ?? null,
    holderId,
    sourceShapeId: manifest?.sourceShapeId ?? null,
    sourceSha256: manifest?.sourceSha256 ?? null,
    status: manifest?.status ?? "invalid",
    segmentIds: Array.isArray(manifest?.segmentIds) ? manifest.segmentIds : [],
    artifactKinds: artifacts.map((artifact) => artifact?.kind).filter(Boolean),
    artifactCount: artifacts.length,
    provider: manifest?.provider ?? null,
    createdAt: manifest?.createdAt ?? null,
    completedAt: manifest?.completedAt ?? null,
    revision: finiteNumber(manifest?.revision, 0),
  };
}

function requireManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.sourceShapeId) ||
    !nonEmptyString(value.sourceSha256) ||
    !Array.isArray(value.segmentIds) ||
    !Array.isArray(value.artifacts) ||
    !Number.isInteger(value.revision)
  ) {
    codedError("invalid_decomposition_manifest", "Scene decomposition metadata is incomplete or malformed.", 409);
  }
  return value;
}

function sanitizeSceneGraph(value, segmentIds) {
  if (value == null) return null;
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    codedError("invalid_scene_graph", "sceneGraph must be JSON serializable.", 400);
  }
  if (Buffer.byteLength(encoded) > 64 * 1024) {
    codedError("scene_graph_too_large", "sceneGraph must be smaller than 64 KiB.", 400);
  }
  const graph = JSON.parse(encoded);
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    codedError("invalid_scene_graph", "sceneGraph must be an object.", 400);
  }
  const objects = Array.isArray(graph.objects) ? graph.objects : [];
  if (objects.length > 64) codedError("scene_graph_too_large", "sceneGraph supports at most 64 objects.", 400);
  for (const object of objects) {
    if (!object || typeof object !== "object") codedError("invalid_scene_graph", "sceneGraph objects must be objects.", 400);
    if (object.segmentId != null && !segmentIds.includes(object.segmentId)) {
      codedError("scene_graph_segment_mismatch", "sceneGraph references a segment outside this decomposition.", 409, {
        segmentId: object.segmentId,
      });
    }
  }
  return graph;
}

async function validateSegments(args, segmentIds, deps) {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0 || segmentIds.length > 32) {
    codedError("invalid_decomposition_segments", "segmentIds must contain 1-32 confirmed segments.", 400);
  }
  const ids = segmentIds.map(nonEmptyString);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    codedError("invalid_decomposition_segments", "segmentIds must be unique valid ids.", 400);
  }
  const store = segmentStoreForArgs(args, deps.resolveCanvasDir);
  const validated = [];
  for (const segmentId of ids) {
    let segment;
    try {
      segment = await store.get(segmentId);
    } catch (error) {
      if (error?.code === "segment_not_found") {
        codedError("segment_not_found", "Decomposition segment was not found.", 404, { segmentId });
      }
      throw error;
    }
    const validation = await validateSegmentSource(args, segment, deps);
    validated.push({ segment, ...validation });
  }
  const first = validated[0].source;
  if (validated.some(({ source }) => (
    source.pageId !== first.pageId ||
    source.shapeId !== first.shapeId ||
    source.assetId !== first.assetId ||
    source.assetSha256 !== first.assetSha256 ||
    source.width !== first.width ||
    source.height !== first.height
  ))) {
    codedError("decomposition_source_mismatch", "All decomposition segments must belong to one current source image.", 409);
  }
  return { ids, source: first, sourceShape: validated[0].sourceShape, segments: validated.map(({ segment }) => segment) };
}

export async function createCowartDecomposition(args = {}, deps) {
  if (args.confirmUpload !== true) {
    codedError(
      "image_upload_confirmation_required",
      "confirmUpload=true is required for each scene decomposition because source image bytes will be sent to Codex image_gen.",
      409
    );
  }
  const validated = await validateSegments(args, args.segmentIds, deps);
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const decompositionId = nonEmptyString(args.decompositionId) || newDecompositionId();
  const existing = decompositionForStore(store, decompositionId);
  if (existing) {
    const manifest = requireManifest(existing.meta.cowartDecomposition);
    const same = manifest.sourceShapeId === validated.source.shapeId
      && manifest.sourceSha256 === validated.source.assetSha256
      && JSON.stringify(manifest.segmentIds) === JSON.stringify(validated.ids);
    if (!same) codedError("decomposition_id_conflict", "decompositionId already exists with different inputs.", 409, { decompositionId });
    return {
      cowartUrl,
      decomposition: summary(manifest, existing.id),
      holderId: existing.id,
      request: existing.meta.cowartRequest ?? null,
      idempotent: true,
      dryRun: Boolean(args.dryRun),
    };
  }
  const sourceShape = getRecord(store, validated.source.shapeId, "decomposition source shape");
  const width = Math.max(1, finiteNumber(args.width, finiteNumber(sourceShape.props?.w, 320)));
  const sourceAspect = validated.source.width / validated.source.height;
  const height = Math.max(1, finiteNumber(args.height, width / sourceAspect));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const origin = choosePlacement({
    store,
    pageId: validated.source.pageId,
    parentId: validated.source.pageId,
    anchorShape: sourceShape,
    width,
    height,
    margin,
    placement,
  });
  const createdAt = nonEmptyString(args.requestedAt) || new Date().toISOString();
  const manifest = {
    id: decompositionId,
    sourceShapeId: validated.source.shapeId,
    sourceSha256: validated.source.assetSha256,
    status: "requested",
    segmentIds: validated.ids,
    sceneGraph: null,
    artifacts: [],
    provider: "codex-image_gen",
    createdAt,
    completedAt: null,
    revision: 1,
  };
  const holderId = uniqueRecordId(store, "shape", sanitizeIdPart(`decomposition-${decompositionId}`, "decomposition"));
  const requestDescriptor = {
    id: decompositionId,
    sourceShapeId: manifest.sourceShapeId,
    sourceSha256: manifest.sourceSha256,
    segmentIds: manifest.segmentIds,
    artifactKinds: ["depth_hint", "clean_plate"],
    uploadConfirmedAt: createdAt,
  };
  const meta = {
    cowartAiImageHolder: true,
    cowartAiImageHolderVersion: 1,
    cowartDecomposition: manifest,
  };
  meta.cowartRequest = makeCowartRequest(meta, {
    requestId: args.requestId,
    requestedAt: createdAt,
    requestKind: "scene_decomposition",
    decomposition: requestDescriptor,
  });
  const holder = {
    id: holderId,
    typeName: "shape",
    type: COWART_AI_IMAGE_SHAPE,
    parentId: validated.source.pageId,
    index: chooseIndex(store, validated.source.pageId),
    x: origin.x,
    y: origin.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta,
    props: {
      w: width,
      h: height,
      name: "Scene decomposition",
      prompt: nonEmptyString(args.prompt)
        || "Create a grayscale relative depth hint and a clean plate with selected foreground objects removed.",
      status: "requested",
      assetId: null,
    },
  };
  if (!args.dryRun) {
    await persistRecords(cowartUrl, store, snapshot, {
      put: [holder],
      conditions: [sourceCondition(validated.source)],
    });
  }
  return {
    cowartUrl,
    decomposition: summary(manifest, holderId),
    holderId,
    request: meta.cowartRequest,
    source: publicSource(validated.source),
    confirmedSegments: validated.segments.map(segmentSummary),
    uploadConfirmed: true,
    idempotent: false,
    dryRun: Boolean(args.dryRun),
  };
}

function artifactIdentityKey(kind, segmentIds, generatedSegmentId = null) {
  return `${kind}\0${[...segmentIds].sort().join("\0")}\0${generatedSegmentId ?? ""}`;
}

async function validateExtractedLayer(args, shape, artifactSource, segmentId, deps) {
  const layer = shape.meta?.cowartObjectLayer;
  if (!layer || layer.segmentId !== segmentId) {
    codedError("untrusted_object_layer", "Object layer must be produced by extract_cowart_object from the declared segment.", 409);
  }
  const segmentStore = segmentStoreForArgs(args, deps.resolveCanvasDir);
  let segment;
  try {
    segment = await segmentStore.get(segmentId);
  } catch (error) {
    if (error?.code === "segment_not_found") {
      codedError("segment_not_found", "Object layer segment was not found.", 404, { segmentId });
    }
    throw error;
  }
  const { source } = await validateSegmentSource(args, segment, deps);
  if (
    layer.sourceShapeId !== source.shapeId ||
    layer.sourceSha256 !== source.assetSha256
  ) {
    codedError("untrusted_object_layer", "Object layer source metadata does not match its confirmed segment.", 409);
  }
  const [sourceBytes, selectionMaskBytes] = await Promise.all([
    readFile(source.sourceFile),
    segmentStore.binary(segmentId, "mask.png"),
  ]);
  const fullSize = artifactSource.width === source.width && artifactSource.height === source.height;
  const expected = await extractMaskedObject({
    sourceBytes,
    selectionMaskBytes,
    width: source.width,
    height: source.height,
    bbox: segment.mask?.bbox,
    crop: !fullSize,
  });
  if (
    expected.width !== artifactSource.width ||
    expected.height !== artifactSource.height ||
    hashBuffer(expected.buffer) !== artifactSource.assetSha256
  ) {
    codedError("object_layer_bytes_mismatch", "Object layer pixels do not match deterministic Segment Store extraction.", 409, {
      segmentId,
    });
  }
  return { segment, source };
}

async function trustedArtifactProvenance(kind, args, shape, artifactSource, manifest, deps) {
  const sourceSegmentIds = Array.isArray(args.sourceSegmentIds)
    ? [...new Set(args.sourceSegmentIds.map(nonEmptyString).filter(Boolean))]
    : [];
  if (sourceSegmentIds.some((id) => !manifest.segmentIds.includes(id))) {
    codedError("artifact_segment_mismatch", "Artifact references a segment outside this decomposition.", 409);
  }
  if (["visible_object_layer", "completed_object"].includes(kind) && sourceSegmentIds.length === 0) {
    codedError("artifact_segment_required", `${kind} requires sourceSegmentIds.`, 400);
  }
  let synthetic;
  let provider;
  let model;
  let generatedSegmentId = null;
  if (kind === "visible_object_layer") {
    synthetic = false;
    provider = "sharp";
    model = "0.35.0";
    const layer = shape.meta?.cowartObjectLayer;
    const layerSegmentId = nonEmptyString(layer?.segmentId);
    if (!layerSegmentId || !sourceSegmentIds.includes(layerSegmentId) || layer?.synthetic !== false) {
      codedError("untrusted_visible_object_layer", "visible_object_layer must represent one declared source segment.", 409);
    }
    const extracted = await validateExtractedLayer(args, shape, artifactSource, layerSegmentId, deps);
    if (
      extracted.source.shapeId !== manifest.sourceShapeId ||
      extracted.source.assetSha256 !== manifest.sourceSha256
    ) {
      codedError("untrusted_visible_object_layer", "visible_object_layer must be extracted from the decomposition source image.", 409);
    }
  } else if (kind === "completed_object") {
    synthetic = true;
    provider = "codex-image_gen";
    model = nonEmptyString(args.model);
    generatedSegmentId = nonEmptyString(args.generatedSegmentId);
    if (!generatedSegmentId) {
      codedError("generated_segment_required", "completed_object requires generatedSegmentId from SAM 2 segmentation of the generated candidate.", 400);
    }
    if (manifest.segmentIds.includes(generatedSegmentId)) {
      codedError("generated_segment_source_mismatch", "completed_object generatedSegmentId must belong to the generated candidate, not the original source.", 409);
    }
    if (shape.meta?.cowartObjectLayer?.synthetic !== true) {
      codedError("untrusted_completed_object", "completed_object must be extracted from an AI-generated candidate.", 409);
    }
    const extracted = await validateExtractedLayer(args, shape, artifactSource, generatedSegmentId, deps);
    if (
      extracted.source.shapeId === manifest.sourceShapeId ||
      extracted.segment.provider?.id !== "cowart-sidecar" ||
      !String(extracted.segment.provider?.model ?? "").includes("sam2")
    ) {
      codedError("generated_segment_source_mismatch", "completed_object must be extracted from a generated image segmented by the local SAM 2 Sidecar.", 409);
    }
  } else if (kind === "composite") {
    synthetic = manifest.artifacts.some((artifact) => artifact.synthetic);
    provider = "sharp";
    model = "0.35.0";
  } else {
    synthetic = true;
    provider = "codex-image_gen";
    model = nonEmptyString(args.model);
  }
  return {
    sourceSegmentIds,
    generatedSegmentId,
    synthetic,
    provider,
    model,
    prompt: typeof args.prompt === "string" ? args.prompt.slice(0, 4000) : null,
  };
}

export async function publishCowartDecompositionArtifact(args = {}, deps) {
  const decompositionId = nonEmptyString(args.decompositionId);
  const kind = nonEmptyString(args.kind);
  const imageShapeId = nonEmptyString(args.imageShapeId) || nonEmptyString(args.shapeId);
  if (!decompositionId) codedError("missing_decomposition_id", "decompositionId is required.", 400);
  if (!DECOMPOSITION_ARTIFACT_KINDS.includes(kind)) {
    codedError("invalid_decomposition_artifact", "Unsupported decomposition artifact kind.", 400, {
      kind,
      allowed: DECOMPOSITION_ARTIFACT_KINDS,
    });
  }
  if (!imageShapeId) codedError("missing_artifact_shape", "imageShapeId is required.", 400);
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const holder = decompositionForStore(store, decompositionId);
  if (!holder) codedError("decomposition_not_found", "Scene decomposition was not found.", 404, { decompositionId });
  const manifest = requireManifest(holder.meta.cowartDecomposition);
  if (imageShapeId === holder.id) {
    codedError("invalid_artifact_shape", "The decomposition coordinator holder cannot also be an artifact.", 409);
  }
  const sourceShape = getRecord(store, manifest.sourceShapeId, "decomposition source shape");
  if (imageShapeId === sourceShape.id) {
    codedError("invalid_artifact_shape", "The decomposition source image cannot be republished as an artifact.", 409);
  }
  const source = await currentSourceIdentity(store, sourceShape, deps.resolveCanvasDir(args), deps);
  if (source.assetSha256 !== manifest.sourceSha256) {
    codedError("source_asset_changed", "Decomposition source image changed.", 409, {
      expectedSourceAssetHash: manifest.sourceSha256,
      currentSourceAssetHash: source.assetSha256,
    });
  }
  const rawArtifactShape = getRecord(store, imageShapeId, "decomposition artifact shape");
  const artifactShape = deps.resolveImageLikeShape(store, rawArtifactShape, { label: "Decomposition artifact" });
  if (!artifactShape) codedError("invalid_artifact_shape", "Decomposition artifact must be a local image or filled image holder.", 400);
  const artifactSource = await currentSourceIdentity(store, artifactShape, deps.resolveCanvasDir(args), deps);
  if (artifactSource.pageId !== source.pageId) {
    codedError("artifact_page_mismatch", "Decomposition artifact must be on the source page.", 409);
  }
  if (
    ["depth_hint", "clean_plate", "composite"].includes(kind) &&
    (artifactSource.width !== source.width || artifactSource.height !== source.height)
  ) {
    codedError("artifact_size_mismatch", `${kind} must use the decomposition source natural dimensions.`, 409, {
      expected: { width: source.width, height: source.height },
      actual: { width: artifactSource.width, height: artifactSource.height },
    });
  }
  const provenance = await trustedArtifactProvenance(kind, args, rawArtifactShape, artifactSource, manifest, deps);
  const identityKey = artifactIdentityKey(kind, provenance.sourceSegmentIds, provenance.generatedSegmentId);
  const existing = manifest.artifacts.find((artifact) => artifact.identityKey === identityKey);
  if (existing) {
    if (existing.artifactSha256 !== artifactSource.assetSha256 || existing.imageShapeId !== imageShapeId) {
      codedError("artifact_conflict", "This decomposition artifact slot is already published.", 409, { kind });
    }
    return {
      cowartUrl,
      decomposition: summary(manifest, holder.id),
      artifact: existing,
      idempotent: true,
      dryRun: Boolean(args.dryRun),
    };
  }
  const sceneGraph = args.sceneGraph !== undefined
    ? sanitizeSceneGraph(args.sceneGraph, manifest.segmentIds)
    : manifest.sceneGraph;
  const artifact = {
    kind,
    imageShapeId,
    sourceSegmentIds: provenance.sourceSegmentIds,
    generatedSegmentId: provenance.generatedSegmentId,
    synthetic: provenance.synthetic,
    prompt: provenance.prompt,
    provider: provenance.provider,
    model: provenance.model,
    sourceSha256: manifest.sourceSha256,
    artifactSha256: artifactSource.assetSha256,
    naturalSize: { width: artifactSource.width, height: artifactSource.height },
    identityKey,
    createdAt: nonEmptyString(args.createdAt) || new Date().toISOString(),
  };
  const artifacts = [...manifest.artifacts, artifact];
  const defaultReady = artifacts.some((item) => item.kind === "depth_hint")
    && artifacts.some((item) => item.kind === "clean_plate");
  const completedAt = defaultReady
    ? manifest.completedAt || nonEmptyString(args.completedAt) || new Date().toISOString()
    : null;
  const updatedManifest = {
    ...manifest,
    status: defaultReady ? "ready" : "generating",
    sceneGraph,
    artifacts,
    completedAt,
    revision: manifest.revision + 1,
  };
  const updatedMeta = { ...holder.meta, cowartDecomposition: updatedManifest };
  const activeRequest = currentHolderRequest(holder);
  const updatedProps = { ...holder.props };
  if (defaultReady && activeRequest) {
    updatedMeta.cowartLastRequest = archiveRequest(activeRequest, { completedAt });
    delete updatedMeta.cowartRequest;
    updatedProps.status = updatedProps.assetId ? "filled" : "empty";
  } else if (activeRequest) {
    updatedProps.status = "generating";
  }
  const updatedHolder = { ...holder, props: updatedProps, meta: updatedMeta };
  const updatedArtifactShape = {
    ...rawArtifactShape,
    meta: {
      ...rawArtifactShape.meta,
      cowartDecompositionArtifact: {
        decompositionId,
        kind,
        sourceSha256: manifest.sourceSha256,
        artifactSha256: artifact.artifactSha256,
        sourceSegmentIds: artifact.sourceSegmentIds,
        generatedSegmentId: artifact.generatedSegmentId,
        synthetic: artifact.synthetic,
        provider: artifact.provider,
        createdAt: artifact.createdAt,
      },
    },
  };
  if (!args.dryRun) {
    await persistRecords(cowartUrl, store, snapshot, {
      put: [updatedHolder, updatedArtifactShape],
      conditions: [
        sourceCondition(source),
        sourceCondition(artifactSource),
        {
          id: holder.id,
          field: "meta.cowartDecomposition.revision",
          equals: manifest.revision,
        },
      ],
    });
  }
  return {
    cowartUrl,
    decomposition: summary(updatedManifest, holder.id),
    artifact,
    idempotent: false,
    dryRun: Boolean(args.dryRun),
  };
}

export function decompositionSummaries(store, pages = null) {
  const allowed = pages
    ? new Set(pages.flatMap((page) => page.shapes.map((shape) => shape.id)))
    : null;
  return Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.meta?.cowartDecomposition)
    .filter((record) => !allowed || allowed.has(record.id))
    .map((record) => summary(record.meta.cowartDecomposition, record.id))
    .filter((item) => item.id && item.sourceShapeId && item.createdAt)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function decompositionReferences(args, snapshot, deps) {
  const decompositionId = nonEmptyString(args.decompositionId);
  if (!decompositionId) return null;
  const store = snapshot.store;
  const holder = decompositionForStore(store, decompositionId);
  if (!holder) codedError("decomposition_not_found", "Scene decomposition was not found.", 404, { decompositionId });
  const manifest = requireManifest(holder.meta.cowartDecomposition);
  const sourceShape = getRecord(store, manifest.sourceShapeId, "decomposition source shape");
  const source = await currentSourceIdentity(store, sourceShape, deps.resolveCanvasDir(args), deps);
  if (source.assetSha256 !== manifest.sourceSha256) {
    codedError("source_asset_changed", "Decomposition source image changed.", 409);
  }
  const roles = new Set(
    Array.isArray(args.decompositionRoles) && args.decompositionRoles.length > 0
      ? args.decompositionRoles
      : ["source", "segments", "artifacts"]
  );
  const references = [];
  if (roles.has("source")) {
    const reference = {
      id: source.shapeId,
      found: true,
      role: "decomposition_source",
      type: sourceShape.type,
      assetFile: source.sourceFile,
      naturalSize: { width: source.width, height: source.height },
      sourceSha256: source.assetSha256,
    };
    if (args.returnBase64 === true) reference.base64 = (await readFile(source.sourceFile)).toString("base64");
    references.push(reference);
  }
  if (roles.has("segments")) {
    const segmentStore = segmentStoreForArgs(args, deps.resolveCanvasDir);
    for (const segmentId of manifest.segmentIds) {
      const segment = await segmentStore.get(segmentId);
      const reference = {
        id: segmentId,
        found: true,
        role: "decomposition_segment",
        type: "mask",
        segment: segmentSummary(segment),
      };
      if (args.returnBase64 === true) reference.base64 = (await segmentStore.binary(segmentId, "mask.png")).toString("base64");
      references.push(reference);
    }
  }
  if (roles.has("artifacts")) {
    for (const artifact of manifest.artifacts) {
      const shape = store[artifact.imageShapeId];
      if (!shape) {
        references.push({ id: artifact.imageShapeId, found: false, role: `decomposition_${artifact.kind}`, artifact });
        continue;
      }
      const imageShape = deps.resolveImageLikeShape(store, shape, { label: "Decomposition artifact" });
      const identity = await currentSourceIdentity(store, imageShape, deps.resolveCanvasDir(args), deps);
      if (identity.assetSha256 !== artifact.artifactSha256) {
        codedError("artifact_asset_changed", "A published decomposition artifact image changed.", 409, {
          imageShapeId: shape.id,
          expectedArtifactSha256: artifact.artifactSha256,
          currentArtifactSha256: identity.assetSha256,
        });
      }
      const reference = {
        id: shape.id,
        found: true,
        role: `decomposition_${artifact.kind}`,
        type: shape.type,
        assetFile: identity.sourceFile,
        naturalSize: { width: identity.width, height: identity.height },
        artifact,
      };
      if (args.returnBase64 === true) reference.base64 = (await readFile(identity.sourceFile)).toString("base64");
      references.push(reference);
    }
  }
  return { holder, manifest, references };
}
