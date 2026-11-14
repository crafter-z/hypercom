import type { KeyboardEvent, ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Single, non-null selection; activating it again never clears it. */
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}

/** A controlled radio group using the existing segmented visual primitives. */
export function SegmentedControl<T extends string>({
  value, options, onChange, disabled = false, className, 'aria-label': label,
}: SegmentedControlProps<T>) {
  const enabled = options.filter(option => !option.disabled);
  const tabStop = enabled.find(option => option.value === value) ?? enabled[0];

  const select = (option: SegmentedOption<T>) => {
    if (!disabled && !option.disabled && option.value !== value) onChange(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, option: SegmentedOption<T>) => {
    if (disabled || option.disabled || enabled.length === 0) return;
    const index = enabled.findIndex(item => item.value === option.value);
    let next: SegmentedOption<T> | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': next = enabled[(index + 1) % enabled.length]; break;
      case 'ArrowLeft':
      case 'ArrowUp': next = enabled[(index - 1 + enabled.length) % enabled.length]; break;
      case 'Home': next = enabled[0]; break;
      case 'End': next = enabled[enabled.length - 1]; break;
      default: return;
    }
    event.preventDefault();
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[options.indexOf(next)]?.focus();
    select(next);
  };

  return (
    <div className={`segmented${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map(option => (
        <button key={option.value} type="button" role="radio"
          className={`segmented-btn${option.value === value ? ' active' : ''}`}
          aria-checked={option.value === value}
          tabIndex={!disabled && option === tabStop ? 0 : -1}
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => select(option)}
          onKeyDown={event => handleKeyDown(event, option)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
