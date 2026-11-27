import crypto from 'node:crypto';

export interface FirestoreConfig {
  projectId: string;
  firestoreDatabaseId: string;
}

export class FirestoreTimestamp {
  readonly isoString: string;

  constructor(isoString: string) {
    this.isoString = isoString;
  }
}

type FirestoreFieldValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values: FirestoreFieldValue[] } }
  | { mapValue: { fields: Record<string, FirestoreFieldValue> } };

export function encodeField(val: unknown): FirestoreFieldValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (val instanceof FirestoreTimestamp) {
    return { timestampValue: val.isoString };
  }
  if (val instanceof Date) {
    return { timestampValue: val.toISOString() };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => encodeField(item)) } };
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const fields: Record<string, FirestoreFieldValue> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) {
        fields[k] = encodeField(v);
      }
    }
    return { mapValue: { fields } };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  return { stringValue: String(val) };
}

export function encodeFields(obj: Record<string, unknown>): Record<string, FirestoreFieldValue> {
  const out: Record<string, FirestoreFieldValue> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      out[key] = encodeField(val);
    }
  }
  return out;
}

export function decodeField(val: Record<string, unknown> | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return String(val.stringValue);
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('arrayValue' in val) {
    const arrObj = val.arrayValue as { values?: Array<Record<string, unknown>> } | undefined;
    const vals = arrObj?.values;
    return Array.isArray(vals) ? vals.map((v) => decodeField(v)) : [];
  }
  if ('mapValue' in val) {
    const mapObj = val.mapValue as { fields?: Record<string, Record<string, unknown>> } | undefined;
    const out: Record<string, unknown> = {};
    if (mapObj?.fields) {
      for (const [k, v] of Object.entries(mapObj.fields)) {
        out[k] = decodeField(v);
      }
    }
    return out;
  }
  return null;
}

export function decodeDocument(doc: {
  name: string;
  fields?: Record<string, Record<string, unknown>>;
}): { id: string; data: Record<string, unknown> } {
  const parts = doc.name.split('/');
  const id = parts[parts.length - 1] || '';
  const data: Record<string, unknown> = {};
  if (doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) {
      data[k] = decodeField(v);
    }
  }
  return { id, data };
}

export function docResourceName(
  cfg: FirestoreConfig,
  collection: string,
  docId: string,
): string {
  const dbId = cfg.firestoreDatabaseId || '(default)';
  return `projects/${cfg.projectId}/databases/${dbId}/documents/${collection}/${docId}`;
}

function baseUrl(cfg: FirestoreConfig): string {
  const dbId = encodeURIComponent(cfg.firestoreDatabaseId || '(default)');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${dbId}/documents`;
}

export async function getFirestoreDoc(
  cfg: FirestoreConfig,
  idToken: string,
  collection: string,
  docId: string,
): Promise<{ exists: boolean; data: Record<string, unknown> | null }> {
  const url = `${baseUrl(cfg)}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) {
    return { exists: false, data: null };
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore GET failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    name: string;
    fields?: Record<string, Record<string, unknown>>;
  };
  return { exists: true, data: decodeDocument(json).data };
}

export async function getPublicFirestoreDoc(
  cfg: FirestoreConfig,
  collection: string,
  docId: string,
): Promise<{ exists: boolean; data: Record<string, unknown> | null }> {
  const url = `${baseUrl(cfg)}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return { exists: false, data: null };
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore public GET failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    name: string;
    fields?: Record<string, Record<string, unknown>>;
  };
  return { exists: true, data: decodeDocument(json).data };
}

export type CommitWriteOp =
  | {
      opType?: 'write';
      collection: string;
      docId: string;
      fields: Record<string, unknown>;
      isCreate: boolean;
      updateMaskFields?: string[];
      serverTimestampFields: string[];
    }
  | {
      opType: 'delete';
      collection: string;
      docId: string;
    };

export async function commitFirestoreWrites(
  cfg: FirestoreConfig,
  idToken: string,
  ops: CommitWriteOp[],
): Promise<void> {
  if (ops.length === 0) return;
  const writes = ops.map((op) => {
    if (op.opType === 'delete') {
      return {
        delete: docResourceName(cfg, op.collection, op.docId),
      };
    }

    const writeObj: Record<string, unknown> = {
      update: {
        name: docResourceName(cfg, op.collection, op.docId),
        fields: encodeFields(op.fields),
      },
      currentDocument: { exists: !op.isCreate },
    };
    if (!op.isCreate && op.updateMaskFields && op.updateMaskFields.length > 0) {
      writeObj.updateMask = { fieldPaths: op.updateMaskFields };
    }
    if (op.serverTimestampFields.length > 0) {
      writeObj.updateTransforms = op.serverTimestampFields.map((fieldPath) => ({
        fieldPath,
        setToServerValue: 'REQUEST_TIME',
      }));
    }
    return writeObj;
  });

  const res = await fetch(`${baseUrl(cfg)}:commit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore commit failed (${res.status}): ${text}`);
  }
}

export async function queryFirestoreCollection(
  cfg: FirestoreConfig,
  idToken: string,
  collectionId: string,
  filter?: {
    fieldPath: string;
    op: 'EQUAL' | 'LESS_THAN_OR_EQUAL' | 'ARRAY_CONTAINS';
    value: unknown;
  },
  limit = 250,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId }],
    limit,
  };
  if (filter) {
    structuredQuery.where = {
      fieldFilter: {
        field: { fieldPath: filter.fieldPath },
        op: filter.op,
        value: encodeField(filter.value),
      },
    };
  }

  const res = await fetch(`${baseUrl(cfg)}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore runQuery failed (${res.status}): ${text}`);
  }

  const rows = (await res.json()) as Array<{
    document?: { name: string; fields?: Record<string, Record<string, unknown>> };
  }>;

  const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const row of rows) {
    if (row.document) {
      docs.push(decodeDocument(row.document));
    }
  }
  return docs;
}

export function computeApproxAreaCoords(
  uid: string,
  exactLat: number | null,
  exactLng: number | null,
): { approxLat: number | null; approxLng: number | null } {
  if (
    exactLat === null ||
    exactLng === null ||
    !Number.isFinite(exactLat) ||
    !Number.isFinite(exactLng)
  ) {
    return { approxLat: null, approxLng: null };
  }
  const gridStep = 0.015;
  const baseLat = Math.round(exactLat / gridStep) * gridStep;
  const baseLng = Math.round(exactLng / gridStep) * gridStep;

  const hash = crypto.createHash('sha256').update(uid).digest();
  const offsetLat = ((hash[0] / 255) - 0.5) * 0.01;
  const offsetLng = ((hash[1] / 255) - 0.5) * 0.01;

  const approxLat = Math.max(-89.9, Math.min(89.9, Number((baseLat + offsetLat).toFixed(4))));
  const approxLng = Math.max(-179.9, Math.min(179.9, Number((baseLng + offsetLng).toFixed(4))));
  return { approxLat, approxLng };
}

export function generateFirestoreId(prefix = ''): string {
  const rand = crypto.randomBytes(10).toString('hex');
  return prefix ? `${prefix}_${rand}` : rand;
}
