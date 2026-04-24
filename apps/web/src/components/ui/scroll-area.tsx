import * as React from 'react';
import { cn } from '../../lib/cn';

const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('min-h-0 overflow-y-auto', className)} {...props} />
  )
);

ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
