import { useRef } from 'react';

interface Props {
  onClose: () => void;
  children: React.ReactNode;
  /** 'dialog' = centered modal, 'panel' = right-side slide panel */
  variant?: 'dialog' | 'panel';
  /** Max width: 'sm' | 'md' | 'lg' | 'xl'. Default 'md' for dialog, 'lg' for panel */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Z-index layer. Default 50 */
  z?: 50 | 60;
}

const sizeMap = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl' };

export default function Modal({ onClose, children, variant = 'dialog', size, z = 50 }: Props) {
  const effectiveSize = size || (variant === 'panel' ? 'lg' : 'md');
  const zClass = z === 60 ? 'z-[60]' : 'z-50';
  // Only close if both mousedown and mouseup happened on the backdrop,
  // not when dragging from inside the modal (e.g. selecting text).
  const mouseDownOnBackdrop = useRef(false);
  const handleMouseDown = (e: React.MouseEvent) => { mouseDownOnBackdrop.current = e.target === e.currentTarget; };
  const handleClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownOnBackdrop.current) onClose();
    mouseDownOnBackdrop.current = false;
  };

  if (variant === 'panel') {
    return (
      <div className={`fixed inset-0 bg-black/60 flex justify-end ${zClass} overflow-hidden`} onMouseDown={handleMouseDown} onClick={handleClick}>
        <div
          className={`w-full ${sizeMap[effectiveSize]} bg-nebula-surface border-l border-nebula-border h-full overflow-y-auto overflow-x-hidden min-w-0`}
          onClick={e => e.stopPropagation()}
        >
          <div className="p-4 sm:p-6">
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 bg-black/60 flex items-center justify-center ${zClass}`} onMouseDown={handleMouseDown} onClick={handleClick}>
      <div
        className={`bg-nebula-surface border border-nebula-border rounded-xl w-full ${sizeMap[effectiveSize]} p-6 max-h-[90vh] overflow-y-auto`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
