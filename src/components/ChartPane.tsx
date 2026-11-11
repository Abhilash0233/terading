import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { formatAxisDay, formatAxisTime, formatBarTime } from "../lib/format";
import { istDateKey } from "../lib/time";
import type { BarIndicators, Candle } from "../lib/types";

export interface ChartLine {
  price: number;
  title: string;
  color: string;
  dashed: boolean;
}

interface Props {
  candles: Candle[];
  indicators: BarIndicators[];
  lines: ChartLine[];
  pinKey: string;
}

export function ChartPane({ candles, indicators, lines, pinKey }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const pinned = useRef("");
  const api = useRef<{
    chart: IChartApi;
    candles: ISeriesApi<"Candlestick">;
    ema9: ISeriesApi<"Line">;
    ema21: ISeriesApi<"Line">;
    vwap: ISeriesApi<"Line">;
    volume: ISeriesApi<"Histogram">;
    rsi: ISeriesApi<"Line">;
    atr: ISeriesApi<"Line">;
    lines: IPriceLine[];
  } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#0c0f13" },
        textColor: "#93a0b0",
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#171c23" },
        horzLines: { color: "#171c23" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a3038" },
      timeScale: {
        borderColor: "#2a3038",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 0,
        barSpacing: 7,
        minBarSpacing: 3,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (time: UTCTimestamp, type: TickMarkType) => {
          const unix = Number(time);
          if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return formatAxisTime(unix);
          return formatAxisDay(unix);
        },
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) => formatBarTime(Number(time)),
      },
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#3ddc97",
      downColor: "#ff6d67",
      borderUpColor: "#3ddc97",
      borderDownColor: "#ff6d67",
      wickUpColor: "#3ddc97",
      wickDownColor: "#ff6d67",
      priceLineColor: "#d7dde6",
    });
    const ema9 = chart.addLineSeries({ color: "#e0b15c", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const ema21 = chart.addLineSeries({ color: "#8eb4d6", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const vwap = chart.addLineSeries({ color: "#d7dde6", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const volume = chart.addHistogramSeries({ priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false });
    const rsi = chart.addLineSeries({ priceScaleId: "rsi", color: "#e0b15c", lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
    const atr = chart.addLineSeries({ priceScaleId: "atr", color: "#9aa7b8", lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
    api.current = { chart, candles: candleSeries, ema9, ema21, vwap, volume, rsi, atr, lines: [] };
    pinned.current = "";
    const resize = () => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    const handle = api.current;
    if (!handle || candles.length === 0) return;
    const hasVolume = candles.some((bar) => bar.volume > 0);
    handle.chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.04, bottom: hasVolume ? 0.36 : 0.28 } });
    handle.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.68, bottom: 0.24 } });
    handle.chart.priceScale("rsi").applyOptions({ scaleMargins: { top: hasVolume ? 0.78 : 0.74, bottom: 0.1 } });
    handle.chart.priceScale("atr").applyOptions({ scaleMargins: { top: 0.92, bottom: 0 } });
    handle.candles.setData(candles.map((bar) => ({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })));
    handle.ema9.setData(lineData(indicators, "ema9"));
    handle.ema21.setData(lineData(indicators, "ema21"));
    handle.vwap.setData(vwapData(indicators));
    handle.volume.setData(hasVolume ? candles.map((bar) => ({
      time: bar.time as UTCTimestamp,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(61,220,151,0.45)" : "rgba(255,109,103,0.4)",
    })) : []);
    handle.rsi.setData(lineData(indicators, "rsi"));
    handle.atr.setData(lineData(indicators, "atr"));
    for (const line of handle.lines) handle.candles.removePriceLine(line);
    handle.lines = lines.map((line) => handle.candles.createPriceLine({
      price: line.price,
      color: line.color,
      lineWidth: 1,
      lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
      axisLabelVisible: true,
      title: line.title,
    }));

    // setData resets the viewport; center the latest bars on symbol/TF open,
    // and keep recent action centered when already following live.
    const forcePin = pinned.current !== pinKey;
    const visible = handle.chart.timeScale().getVisibleLogicalRange();
    const last = candles.length - 1;
    const nearLive = visible == null || Math.abs((visible.from + visible.to) / 2 - last) <= 12;
    if (forcePin || nearLive) {
      pinned.current = pinKey;
      const window = 120;
      const half = window / 2;
      handle.chart.timeScale().setVisibleLogicalRange({
        from: last - half,
        to: last + half,
      });
    }
  }, [candles, indicators, lines, pinKey]);

  return <div ref={host} className="chart-host" data-testid="chart" />;
}

function lineData(indicators: BarIndicators[], key: "ema9" | "ema21" | "rsi" | "atr") {
  const data: { time: UTCTimestamp; value: number }[] = [];
  for (const point of indicators) {
    const value = point[key];
    if (value == null || !Number.isFinite(value)) continue;
    data.push({ time: point.time as UTCTimestamp, value });
  }
  return data;
}

function vwapData(indicators: BarIndicators[]) {
  const data: ({ time: UTCTimestamp; value: number } | { time: UTCTimestamp })[] = [];
  let previous = "";
  for (const point of indicators) {
    if (point.vwap == null) continue;
    const day = istDateKey(point.time);
    if (previous && previous !== day) data.push({ time: (point.time - 1) as UTCTimestamp });
    previous = day;
    data.push({ time: point.time as UTCTimestamp, value: point.vwap });
  }
  return data;
}
