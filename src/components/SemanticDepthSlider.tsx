import type {
  ComponentProps,
  PointerEvent,
} from 'react';
import { useEffect, useRef } from 'react';

const THUMB_SIZE = 28;
const THUMB_RADIUS = THUMB_SIZE / 2;

interface TrackPointerOptions {
  pointerX: number;
  trackLeft: number;
  trackWidth: number;
  value: number;
  min?: number;
  max: number;
}

export function depthFromTrackPointer({
  pointerX,
  trackLeft,
  trackWidth,
  value,
  min = 1,
  max,
}: TrackPointerOptions): number | null {
  const usableTrackWidth = trackWidth - THUMB_SIZE;
  if (usableTrackWidth <= 0 || max <= min) return null;

  const boundedValue = Math.min(max, Math.max(min, value));
  const valueRatio = (boundedValue - min) / (max - min);
  const usableTrackLeft = trackLeft + THUMB_RADIUS;
  const thumbCenter = usableTrackLeft + valueRatio * usableTrackWidth;
  if (Math.abs(pointerX - thumbCenter) <= THUMB_RADIUS) {
    return null;
  }

  const pointerRatio = Math.min(
    1,
    Math.max(0, (pointerX - usableTrackLeft) / usableTrackWidth),
  );
  const nearestValue = Math.round(min + pointerRatio * (max - min));
  const direction = pointerX < thumbCenter ? -1 : 1;
  const nextValue = nearestValue === boundedValue
    ? boundedValue + direction
    : nearestValue;

  return Math.min(max, Math.max(min, nextValue));
}

interface SemanticDepthSliderProps extends Omit<
  ComponentProps<'input'>,
  | 'max'
  | 'min'
  | 'onChange'
  | 'onPointerDownCapture'
  | 'ref'
  | 'step'
  | 'type'
  | 'value'
> {
  value: number;
  max: number;
  onDepthChange: (depth: number) => void;
}

export function SemanticDepthSlider({
  value,
  max,
  onDepthChange,
  disabled,
  ...inputProps
}: SemanticDepthSliderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressNextTouchStartRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const suppressHandledTouch = (event: TouchEvent) => {
      if (!suppressNextTouchStartRef.current) return;
      suppressNextTouchStartRef.current = false;
      event.preventDefault();
    };
    input.addEventListener('touchstart', suppressHandledTouch, {
      passive: false,
    });
    return () => {
      input.removeEventListener('touchstart', suppressHandledTouch);
    };
  }, []);

  const applyTrackClick = (
    input: HTMLInputElement,
    pointerX: number,
  ) => {
    const bounds = input.getBoundingClientRect();
    const nextDepth = depthFromTrackPointer({
      pointerX,
      trackLeft: bounds.left,
      trackWidth: bounds.width,
      value,
      max,
    });
    if (nextDepth === null) return false;

    input.focus();
    onDepthChange(nextDepth);
    return true;
  };

  const handlePointerDownCapture = (
    event: PointerEvent<HTMLInputElement>,
  ) => {
    if (
      disabled
      || event.isPrimary === false
      || event.button > 0
    ) {
      return;
    }

    if (applyTrackClick(event.currentTarget, event.clientX)) {
      suppressNextTouchStartRef.current = event.pointerType === 'touch';
      event.preventDefault();
    }
  };

  return (
    <input
      {...inputProps}
      ref={inputRef}
      type="range"
      min={1}
      max={max}
      step={1}
      value={value}
      disabled={disabled}
      onChange={(event) => onDepthChange(Number(event.target.value))}
      onPointerDownCapture={handlePointerDownCapture}
    />
  );
}
