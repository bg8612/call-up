import * as React from 'react';
import { cn } from '../../lib/cn';

type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

const useTabsContext = () => {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs components must be used within Tabs.');
  }
  return context;
};

export const Tabs = ({
  value,
  onValueChange,
  className,
  children
}: React.HTMLAttributes<HTMLDivElement> & { value: string; onValueChange: (value: string) => void }) => (
  <TabsContext.Provider value={{ value, setValue: onValueChange }}>
    <div className={cn('flex min-h-0 flex-col', className)}>{children}</div>
  </TabsContext.Provider>
);

export const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'inline-flex h-11 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1',
        className
      )}
      {...props}
    />
  )
);

export const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }
>(({ className, value, ...props }, ref) => {
  const { value: activeValue, setValue } = useTabsContext();
  const isActive = activeValue === value;

  return (
    <button
      ref={ref}
      type="button"
      data-state={isActive ? 'active' : 'inactive'}
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]',
        isActive
          ? 'border-[var(--border-strong)] bg-[var(--surface-elevated)] text-[var(--text-primary)]'
          : 'border-transparent text-[var(--text-secondary)] hover:border-[var(--border)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
        className
      )}
      onClick={() => setValue(value)}
      {...props}
    />
  );
});

export const TabsContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { value: string }>(
  ({ className, value, ...props }, ref) => {
    const { value: activeValue } = useTabsContext();
    if (activeValue !== value) {
      return null;
    }

    return <div ref={ref} className={cn('min-h-0 flex-1', className)} {...props} />;
  }
);

TabsList.displayName = 'TabsList';
TabsTrigger.displayName = 'TabsTrigger';
TabsContent.displayName = 'TabsContent';
