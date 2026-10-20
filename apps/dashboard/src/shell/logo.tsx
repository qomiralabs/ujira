// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

interface LogoProps {
  /** The lockup needs 110px; below that the mark stands alone. */
  variant: 'lockup' | 'mark';
  className?: string;
}

// The rail is always teal, so it carries the reverse colourway in both modes.
// The supplied artwork is used as is: never redrawn or recoloured.
export function Logo({ variant, className = '' }: LogoProps) {
  if (variant === 'mark') {
    return (
      <img
        src="/brand/ujira_mark_primary_default-reverse.svg"
        alt="UJIRA"
        width={32}
        height={32}
        className={className}
      />
    );
  }
  return (
    <img
      src="/brand/ujira_lockup-horizontal_default-reverse.svg"
      alt="UJIRA"
      width={122}
      height={32}
      className={className}
    />
  );
}
