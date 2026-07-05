// =============================================================================
// DeepAnalyze - ChartRenderer
// Renders ECharts charts from a JSON option string.
// =============================================================================

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

interface ChartRendererProps {
  /** ECharts option as a JSON string or parsed object */
  option: string | Record<string, unknown>;
  /** Height of the chart container (default: 350px) */
  height?: number;
}

export function ChartRenderer({ option, height = 350 }: ChartRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize chart
    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;

    // Parse and set option
    try {
      const parsed = typeof option === "string" ? JSON.parse(option) : option;
      chart.setOption(parsed, true);
    } catch (err) {
      console.error("Failed to parse chart option:", err);
    }

    // Handle window resize
    const handleResize = () => chart.resize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [option]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height }}
    />
  );
}
