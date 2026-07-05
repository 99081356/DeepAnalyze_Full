// =============================================================================
// DeepAnalyze - Module Stubs for External Dependencies
// =============================================================================
// These are stub declarations for modules referenced by the copied Claude Code
// harness code but not needed in the DeepAnalyze project. They provide minimal
// type declarations to allow TypeScript compilation.
// =============================================================================

// --- Anthropic SDK Extensions ---
declare module "@anthropic-ai/bedrock-sdk" {
  export default class AnthropicBedrock {
    constructor(options?: Record<string, unknown>);
  }
}

declare module "@anthropic-ai/vertex-sdk" {
  export default class AnthropicVertex {
    constructor(options?: Record<string, unknown>);
  }
}

declare module "@anthropic-ai/foundry-sdk" {
  export default class AnthropicFoundry {
    constructor(options?: Record<string, unknown>);
  }
}

declare module "@anthropic-ai/mcpb" {
  export function createMCPClient(options?: Record<string, unknown>): any;
}

declare module "@anthropic-ai/sandbox-runtime" {
  export function createSandbox(options?: Record<string, unknown>): any;
}

// --- Ant/Computer Use ---
declare module "@ant/claude-for-chrome-mcp" {
  export const chromeMCP: any;
}

declare module "@ant/computer-use-input" {
  export function createInput(options?: Record<string, unknown>): any;
}

declare module "@ant/computer-use-mcp" {
  export function createComputerUseMCP(options?: Record<string, unknown>): any;
}

declare module "@ant/computer-use-mcp/sentinelApps" {
  export const sentinelApps: string[];
}

declare module "@ant/computer-use-mcp/types" {
  export interface ComputerUseOptions {
    displayWidthPx?: number;
    displayHeightPx?: number;
  }
}

declare module "@ant/computer-use-swift" {
  export function createComputerUseSwift(options?: Record<string, unknown>): any;
}

// --- AWS SDK ---
declare module "@aws-sdk/client-bedrock" {
  export class BedrockClient {
    constructor(options?: Record<string, unknown>);
    send(command: any): Promise<any>;
  }
}

declare module "@aws-sdk/client-bedrock-runtime" {
  export class BedrockRuntimeClient {
    constructor(options?: Record<string, unknown>);
    send(command: any): Promise<any>;
  }
}

declare module "@aws-sdk/client-sts" {
  export class STSClient {
    constructor(options?: Record<string, unknown>);
    send(command: any): Promise<any>;
  }
}

declare module "@aws-sdk/credential-provider-node" {
  export function defaultProvider(options?: Record<string, unknown>): any;
}

declare module "@aws-sdk/credential-providers" {
  export function fromNodeProviderChain(options?: Record<string, unknown>): any;
}

// --- Azure ---
declare module "@azure/identity" {
  export class DefaultAzureCredential {}
  export class ClientSecretCredential {
    constructor(tenantId: string, clientId: string, clientSecret: string);
  }
}

// --- GrowthBook ---
declare module "@growthbook/growthbook" {
  export class GrowthBook {
    constructor(options?: Record<string, unknown>);
    isOn(key: string): boolean;
    getFeatureValue(key: string, defaultValue: any): any;
  }
}

// --- OpenTelemetry ---
declare module "@opentelemetry/api" {
  export const trace: { getTracer(name: string, version?: string): any };
  export const metrics: { getMeter(name: string, version?: string): any };
  export const context: { active(): any };
  export type Span = any;
  export type Tracer = any;
  export type Meter = any;
  export type Context = any;
  export type Attributes = Record<string, string | number | boolean>;
  export interface MetricOptions { description?: string; unit?: string; }
  export interface Counter { add(value: number, attributes?: Attributes): void; }
  export interface Histogram { record(value: number, attributes?: Attributes): void; }
  export interface UpDownCounter { add(value: number, attributes?: Attributes): void; }
}

declare module "@opentelemetry/api-logs" {
  export class Logger { log(message: string, options?: any): void; }
  export const logs: { getLogger(name: string, version?: string): Logger };
}

declare module "@opentelemetry/core" {
  export function createConsoleExporter(): any;
}

declare module "@opentelemetry/sdk-trace-base" {
  export class BasicTracerProvider {
    register(): void;
    getTracer(name: string): any;
  }
}

declare module "@opentelemetry/sdk-logs" {
  export class LoggerProvider {
    register(): void;
    getLogger(name: string): any;
  }
}

declare module "@opentelemetry/sdk-metrics" {
  export class MeterProvider {
    getMeter(name: string): any;
  }
}

declare module "@opentelemetry/resources" {
  export class Resource {
    constructor(attributes: Record<string, string>);
  }
}

declare module "@opentelemetry/semantic-conventions" {
  export const ATTR_SERVICE_NAME: string;
  export const ATTR_SERVICE_VERSION: string;
}

// Generate stubs for all OTLP exporters
declare module "@opentelemetry/exporter-logs-otlp-grpc" {
  export class OTLPLogExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-logs-otlp-http" {
  export class OTLPLogExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-logs-otlp-proto" {
  export class OTLPLogExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-metrics-otlp-grpc" {
  export class OTLPMetricExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-metrics-otlp-http" {
  export class OTLPMetricExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-metrics-otlp-proto" {
  export class OTLPMetricExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-prometheus" {
  export class PrometheusExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-trace-otlp-grpc" {
  export class OTLPTraceExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-trace-otlp-http" {
  export class OTLPTraceExporter { constructor(options?: any); }
}
declare module "@opentelemetry/exporter-trace-otlp-proto" {
  export class OTLPTraceExporter { constructor(options?: any); }
}

// --- Smithy ---
declare module "@smithy/core" {
  export class SmithyException extends Error {}
}

declare module "@smithy/node-http-handler" {
  export class NodeHttpHandler {
    constructor(options?: Record<string, unknown>);
  }
}

// --- Utility Libraries ---
declare module "asciichart" {
  export function plot(series: number[] | number[][], options?: any): string;
}

declare module "bidi-js" {
  export function getReorderedString(text: string, options?: any): string;
}

declare module "cacache" {
  export function get(cacheDir: string, key: string): Promise<{ data: Buffer; metadata: any }>;
  export function put(cacheDir: string, key: string, data: Buffer | string, options?: any): Promise<string>;
  export function rm(cacheDir: string, key: string): Promise<void>;
  export function ls(cacheDir: string): AsyncIterable<{ key: string }>;
}

declare module "cli-boxes" {
  const boxes: { single: string; double: string; round: string; bold: string; singleDouble: string; doubleSingle: string; classic: string; arrow: string; };
  export default boxes;
}

declare module "code-excerpt" {
  export default function excerpt(filePath: string, options?: any): string;
}

declare module "color-diff-napi" {
  export function closest(color: [number, number, number], palette: [number, number, number][]): [number, number, number];
}

declare module "env-paths" {
  export default function envPaths(name: string, options?: { suffix?: string }): {
    data: string;
    config: string;
    cache: string;
    log: string;
    temp: string;
  };
}

declare module "google-auth-library" {
  export class GoogleAuth {
    constructor(options?: Record<string, unknown>);
    getAccessToken(): Promise<string>;
  }
}

declare module "image-processor-napi" {
  export function resize(image: Buffer, options: Record<string, unknown>): Buffer;
}

declare module "indent-string" {
  export default function indentString(str: string, count?: number, options?: { includeEmptyLines?: boolean }): string;
}

declare module "stack-utils" {
  export default class StackUtils {
    constructor(options?: { cwd?: string; ignoredPackages?: string[] });
    clean(stack: string): string;
  }
}

declare module "url-handler-napi" {
  export function open(url: string): void;
}

declare module "usehooks-ts" {
  export function useDebounce<T>(value: T, delay: number): T;
  export function useInterval(callback: () => void, delay: number | null): void;
  export function useToggle(initialValue?: boolean): [boolean, () => void];
  export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void];
}

// --- React Compiler Runtime ---
declare module "react/compiler-runtime" {
  export function c<T>(value: T): T;
}

declare module "vscode-jsonrpc/node.js" {
  export interface MessageConnection {
    listen(): void;
    sendRequest(type: any, params: any): Promise<any>;
    sendNotification(type: any, params: any): void;
    onRequest(type: any, handler: any): void;
    onNotification(type: any, handler: any): void;
  }
}

declare module "vscode-languageserver-protocol" {
  export const InitializeRequest: any;
  export const CompletionRequest: any;
  export const HoverRequest: any;
}

declare module "vscode-languageserver-types" {
  export namespace Diagnostic {
    function create(range: any, message: string, severity?: number): any;
  }
  export namespace Position {
    function create(line: number, character: number): any;
  }
  export namespace Range {
    function create(start: any, end: any): any;
  }
  export enum DiagnosticSeverity {
    Error = 1,
    Warning = 2,
    Information = 3,
    Hint = 4,
  }
}

declare module "@alcalzone/ansi-tokenize" {
  export function tokenize(input: string): any[];
}

// --- Markdown file modules (Bun raw imports) ---
declare module "*.md" {
  const content: string;
  export default content;
}

// --- Bun runtime ---
declare module "bun:bundle" {
  export function feature(name: string): boolean;
  export function env(key: string): string | undefined;
}

declare module "bun" {
  export function spawn(options: Record<string, unknown>): any;
  export function sleep(ms: number): Promise<void>;
  export const Bun: {
    env: Record<string, string | undefined>;
    serve(options: Record<string, unknown>): any;
    file(path: string): { text(): Promise<string>; json(): Promise<any> };
  };
}

// --- Skill Markdown files ---
declare module "*/SKILL.md" {
  const content: string;
  export default content;
}

// --- AttributionTrailer ---
declare module "*/attributionTrailer.js" {
  export function getAttributionTrailer(): string;
}
