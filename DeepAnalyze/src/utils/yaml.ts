/**
 * YAML parsing wrapper.
 *
 * Uses Bun.YAML (built-in, zero-cost) when running under Bun, otherwise falls
 * back to the `yaml` npm package via a top-level import.
 */
import { parse as yamlParse } from 'yaml'

export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)
  }
  return yamlParse(input)
}
