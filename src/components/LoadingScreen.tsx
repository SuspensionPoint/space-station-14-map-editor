import React from 'react';
import { RepositoryLink } from './RepositoryLink';

interface Props {
  message: string;
}

export const LoadingScreen: React.FC<Props> = ({ message }) => {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-panel text-primary font-['Segoe_UI',sans-serif] gap-5 z-[1000]">
      <div className="text-2xl font-semibold text-accent">
        SS14 Map Editor
      </div>

      <div className="w-[300px] h-1 bg-hover rounded overflow-hidden">
        <div className="h-full bg-accent rounded animate-[loading-pulse_1.5s_ease-in-out_infinite] w-[40%]" />
      </div>

      <div className="text-[13px] text-muted">
        {message}
      </div>

      <RepositoryLink className="absolute bottom-4 right-5" />

      <style>{`
        @keyframes loading-pulse {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
    </div>
  );
};
