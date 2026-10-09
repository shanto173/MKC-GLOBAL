/**
 * Supabase Storage, in memory: what the chat's files are kept in.
 *
 * Strict where the real one is: an upload over an existing path without
 * upsert is refused, a signed link to a path that holds nothing is "Object not
 * found", and a signed upload address is good for one path. `put()` is the
 * browser's half - the PUT to that address - so a test can upload exactly as
 * the desk does.
 */

export function fakeStorage(files = {}) {
  const objects = new Map(Object.entries(files).map(([p, v]) => [p, typeof v === 'object' && v.buffer ? v : { buffer: Buffer.from(v), mime: 'application/octet-stream' }]));
  const uploads = new Map();
  const calls = { upload: [], signed: [], signedUpload: [], download: [] };
  let n = 0;
  const bucket = {
    async upload(path, buffer, opts = {}) {
      calls.upload.push(path);
      if (objects.has(path) && !opts.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
      objects.set(path, { buffer: Buffer.from(buffer), mime: opts.contentType ?? 'application/octet-stream' });
      return { data: { path }, error: null };
    },
    async createSignedUrl(path, seconds) {
      calls.signed.push(path);
      if (!objects.has(path)) return { data: null, error: { message: 'Object not found' } };
      return { data: { signedUrl: `https://storage.test/sign/${encodeURIComponent(path)}?expires=${seconds}` }, error: null };
    },
    async createSignedUploadUrl(path, opts = {}) {
      calls.signedUpload.push(path);
      const token = `t${++n}`;
      uploads.set(token, { path, upsert: Boolean(opts.upsert) });
      return { data: { signedUrl: `https://storage.test/upload/sign/booking-docs/${path}?token=${token}`, token, path }, error: null };
    },
    async download(path) {
      calls.download.push(path);
      const f = objects.get(path);
      return f ? { data: new Blob([f.buffer], { type: f.mime }), error: null } : { data: null, error: { message: 'Object not found' } };
    },
  };
  return {
    calls,
    objects,
    from: () => bucket,
    /** The browser's upload to a signed address. */
    put(signedUrl, buffer, mime = 'application/octet-stream') {
      const token = new URL(signedUrl).searchParams.get('token');
      const slot = uploads.get(token);
      if (!slot) throw new Error('fake-storage: unknown upload token');
      objects.set(slot.path, { buffer: Buffer.from(buffer), mime });
      return slot.path;
    },
  };
}
