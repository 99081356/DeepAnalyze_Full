import fs from 'node:fs';
import path from 'node:path';

export interface DoclingRemoteConfig {
  endpoint: string;
  apiKey?: string;
  protocol: 'docling-rest';
}

export interface DoclingParseInput {
  filePath: string;
  parseMethod?: 'auto' | 'ocr' | 'txt';
  options?: Record<string, unknown>;
}

export interface DoclingParseResult {
  mdContent: string;
  jsonContent?: unknown;
  images?: string[];
  parseMethod?: string;
}

export class DoclingRemoteClient {
  constructor(private config: DoclingRemoteConfig) {
    // Strip trailing slash
    this.config.endpoint = config.endpoint.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.config.endpoint}/health`, { headers: this.headers() });
      return r.ok;
    } catch {
      return false;
    }
  }

  async parse(input: DoclingParseInput): Promise<DoclingParseResult> {
    const filePath = input.filePath;
    if (!fs.existsSync(filePath)) {
      throw new Error(`file not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    // Use FormData for multipart upload (Node 18+ built-in)
    const form = new FormData();
    const blob = new Blob([fileBuffer]);
    form.append('file', blob, fileName);
    if (input.parseMethod) form.append('parse_method', input.parseMethod);
    if (input.options) {
      for (const [k, v] of Object.entries(input.options)) {
        form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }

    const r = await fetch(`${this.config.endpoint}/file_parse`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`docling remote parse failed: ${r.status} ${txt}`);
    }

    const json: any = await r.json();
    return {
      mdContent: json.md_content ?? json.md ?? '',
      jsonContent: json.json_content ?? json.content,
      images: json.images ?? [],
      parseMethod: json.parse_method,
    };
  }
}
