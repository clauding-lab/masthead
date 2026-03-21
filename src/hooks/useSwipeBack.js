import { useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const EDGE_THRESHOLD = 30; // px from left edge to start
const SWIPE_THRESHOLD = 80; // px distance to trigger back

export default function useSwipeBack(containerRef) {
  const navigate = useNavigate();
  const startX = useRef(0);
  const startY = useRef(0);
  const swiping = useRef(false);
  const overlayRef = useRef(null);

  const handleTouchStart = useCallback((e) => {
    const touch = e.touches[0];
    if (touch.clientX < EDGE_THRESHOLD) {
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      swiping.current = true;
    }
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (!swiping.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX.current;
    const dy = Math.abs(touch.clientY - startY.current);

    // Cancel if vertical scroll dominates
    if (dy > dx && dx < 20) {
      swiping.current = false;
      return;
    }

    if (dx > 0 && containerRef.current) {
      const progress = Math.min(dx / 200, 1);
      containerRef.current.style.transform = `translateX(${dx}px)`;
      containerRef.current.style.opacity = 1 - progress * 0.3;

      if (!overlayRef.current) {
        overlayRef.current = document.createElement('div');
        overlayRef.current.style.cssText = `
          position: fixed; top: 0; left: 0; width: 100%; height: 100%;
          z-index: 39; pointer-events: none;
          background: linear-gradient(90deg, rgba(0,0,0,0.08), transparent 30px);
        `;
        document.body.appendChild(overlayRef.current);
      }
    }
  }, [containerRef]);

  const handleTouchEnd = useCallback((e) => {
    if (!swiping.current) return;
    swiping.current = false;

    if (overlayRef.current) {
      overlayRef.current.remove();
      overlayRef.current = null;
    }

    if (!containerRef.current) return;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX.current;

    if (dx > SWIPE_THRESHOLD) {
      containerRef.current.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out';
      containerRef.current.style.transform = 'translateX(100%)';
      containerRef.current.style.opacity = '0';
      setTimeout(() => navigate(-1), 180);
    } else {
      containerRef.current.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out';
      containerRef.current.style.transform = 'translateX(0)';
      containerRef.current.style.opacity = '1';
      setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.style.transition = '';
        }
      }, 200);
    }
  }, [containerRef, navigate]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd);
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [containerRef, handleTouchStart, handleTouchMove, handleTouchEnd]);
}
