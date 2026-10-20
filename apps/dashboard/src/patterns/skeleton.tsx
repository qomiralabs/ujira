// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

interface SkeletonProps {
  className: string;
}

/** A placeholder block the size of the content it stands in for. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      className={`block animate-skeleton rounded-control bg-rule ${className}`}
    />
  );
}

/**
 * The page layout while a page loads: the header and one card, at the sizes
 * the loaded page uses, so nothing moves when the content arrives.
 */
export function PageSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <div className="flex flex-col gap-4 rounded-card border border-rule bg-surface p-6 md:p-8">
        <Skeleton className="size-6" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-5 w-full max-w-prose" />
        <Skeleton className="h-5 w-3/4 max-w-prose" />
      </div>
    </div>
  );
}
