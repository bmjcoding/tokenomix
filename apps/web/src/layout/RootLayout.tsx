import { Outlet } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './Sidebar.js';

/**
 * RootLayout — fixed sidebar on the left, main content on the right.
 *
 * Uses a ResizeObserver on the sidebar element to track its actual rendered
 * width and offset the main content area accordingly. This means the sidebar
 * width is declared in exactly one place (Sidebar.tsx) and the main content
 * reacts to it — no duplicated `w-72` magic numbers here.
 */
export function RootLayout() {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(0);

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setSidebarWidth(entry.contentRect.width);
      }
    });

    observer.observe(el);
    // Set initial width synchronously so we don't start with 0.
    setSidebarWidth(el.getBoundingClientRect().width);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background dark:bg-background-dark">
      {/* Sidebar — observed via ResizeObserver in the wrapper div */}
      <div ref={sidebarRef} className="fixed inset-y-0 left-0 z-20">
        <Sidebar />
      </div>

      {/* Main content area — offset by the sidebar's actual width */}
      <main
        className="flex-1 min-h-screen"
        style={{ paddingLeft: sidebarWidth > 0 ? `${sidebarWidth}px` : undefined }}
      >
        <div className="px-6 py-6 max-w-screen-xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
