import React, { useEffect, useState } from 'react';
import { clampNumber } from '../../utils/clampNumber';

export interface NumericInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> {
  value: number;
  min: number;
  max: number;
  /** Called with the clamped integer on blur or Enter (not on every keystroke). */
  onCommit: (value: number) => void;
}

/**
 * Integer input that keeps a raw draft while typing.
 *
 * Clamping in `onChange` made values unreachable: typing "24" into a min-8
 * field became 2 → 8, then the next keystroke produced 84. The draft commits
 * on blur/Enter, so intermediate prefixes stay editable.
 */
export const NumericInput: React.FC<NumericInputProps> = ({
  value,
  min,
  max,
  onCommit,
  onBlur,
  onKeyDown,
  ...rest
}) => {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = clampNumber(draft, min, max);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
};

export default NumericInput;
