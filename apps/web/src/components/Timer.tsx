'use client';

import { useState, useEffect } from 'react';

interface TimerProps {
  startTime: number | null;
  isRunning: boolean;
  finalTime?: number | null;
  isInspection?: boolean;
  inspectionDuration?: number;
}

export function Timer({
  startTime,
  isRunning,
  finalTime,
  isInspection = false,
  inspectionDuration = 15000,
}: TimerProps) {
  const [displayTime, setDisplayTime] = useState(0);

  useEffect(() => {
    if (finalTime !== undefined && finalTime !== null) {
      setDisplayTime(finalTime);
      return;
    }

    if (!isRunning || !startTime) {
      if (isInspection && startTime) {
        // Show countdown
        const remaining = Math.max(0, inspectionDuration - (Date.now() - startTime));
        setDisplayTime(remaining);
      }
      return;
    }

    const interval = setInterval(() => {
      if (isInspection) {
        const remaining = Math.max(0, inspectionDuration - (Date.now() - startTime));
        setDisplayTime(remaining);
      } else {
        setDisplayTime(Date.now() - startTime);
      }
    }, 10);

    return () => clearInterval(interval);
  }, [startTime, isRunning, finalTime, isInspection, inspectionDuration]);

  const formatTime = (ms: number) => {
    if (isInspection) {
      const seconds = Math.ceil(ms / 1000);
      return seconds.toString();
    }

    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);

    if (minutes > 0) {
      return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
    }
    return `${seconds}.${centiseconds.toString().padStart(2, '0')}`;
  };

  const getColor = () => {
    if (isInspection) {
      const seconds = displayTime / 1000;
      if (seconds <= 3) return 'text-red-500';
      if (seconds <= 8) return 'text-yellow-500';
      return 'text-green-500';
    }
    return 'text-white';
  };

  return (
    <div className={`timer text-6xl font-bold ${getColor()}`}>
      {formatTime(displayTime)}
      {isInspection && <span className="text-2xl ml-2">s</span>}
    </div>
  );
}
