import * as React from 'react';
import { cn } from '../../lib/cn';

type AvatarProps = React.HTMLAttributes<HTMLDivElement>;

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-muted)] text-sm font-semibold text-[var(--text-primary)]',
      className
    )}
    {...props}
  />
));

const AvatarFallback = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span ref={ref} className={cn('flex size-full items-center justify-center', className)} {...props} />
  )
);

Avatar.displayName = 'Avatar';
AvatarFallback.displayName = 'AvatarFallback';

export { Avatar, AvatarFallback };
