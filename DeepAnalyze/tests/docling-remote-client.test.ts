import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoclingRemoteClient } from '../src/services/document-processors/docling-remote-client.ts';

describe('DoclingRemoteClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('health returns true on 200', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    }) as any);

    const client = new DoclingRemoteClient({ endpoint: 'https://docling.example.com', protocol: 'docling-rest' });
    const ok = await client.health();
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://docling.example.com/health', expect.any(Object));
  });

  it('health returns false on network error', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const client = new DoclingRemoteClient({ endpoint: 'https://docling.example.com', protocol: 'docling-rest' });
    const ok = await client.health();
    expect(ok).toBe(false);
  });

  it('parse posts multipart with file', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        md_content: '# Title\n\nBody',
        images: [],
      }),
    }) as any);

    const client = new DoclingRemoteClient({
      endpoint: 'https://docling.example.com',
      apiKey: 'sk-secret',
      protocol: 'docling-rest',
    });

    // Create a temporary file
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpPath = path.join(os.tmpdir(), `test-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, Buffer.from('%PDF-1.4 fake'));

    const result = await client.parse({ filePath: tmpPath });
    expect(result.mdContent).toBe('# Title\n\nBody');
    expect(fetch).toHaveBeenCalledWith(
      'https://docling.example.com/file_parse',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-secret' }),
      }),
    );

    fs.unlinkSync(tmpPath);
  });

  it('parse throws on error response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as any);

    const client = new DoclingRemoteClient({ endpoint: 'https://docling.example.com', protocol: 'docling-rest' });

    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpPath = path.join(os.tmpdir(), `err-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, Buffer.from('fake'));

    await expect(client.parse({ filePath: tmpPath })).rejects.toThrow(/500/);

    fs.unlinkSync(tmpPath);
  });
});
