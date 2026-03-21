import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

export default function PageTransition({ children }) {
  const location = useLocation();
  const [displayChildren, setDisplayChildren] = useState(children);
  const [transitioning, setTransitioning] = useState(false);
  const prevPath = useRef(location.pathname);

  useEffect(() => {
    if (location.pathname !== prevPath.current) {
      prevPath.current = location.pathname;
      setTransitioning(true);
      // Short fade to new content
      const timer = setTimeout(() => {
        setDisplayChildren(children);
        setTransitioning(false);
      }, 100);
      return () => clearTimeout(timer);
    } else {
      setDisplayChildren(children);
    }
  }, [children, location.pathname]);

  return (
    <div
      style={{
        opacity: transitioning ? 0 : 1,
        transform: transitioning ? 'translateY(4px)' : 'translateY(0)',
        transition: 'opacity 150ms ease-out, transform 150ms ease-out',
      }}
    >
      {displayChildren}
    </div>
  );
}
