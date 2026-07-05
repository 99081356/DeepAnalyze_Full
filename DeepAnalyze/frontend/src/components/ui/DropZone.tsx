import React, { useState, useCallback, useRef } from 'react';
import { Upload, FileText } from 'lucide-react';
import { cn } from '../../utils/cn';

interface DropZoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
  hint?: string;
}

export function DropZone({
  onFiles,
  accept,
  multiple = true,
  className,
  style,
  label = 'Drag and drop files here',
  hint = 'or click to browse',
}: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filterFiles = useCallback(
    (files: FileList | File[]): File[] => {
      const fileArray = Array.from(files);
      if (!accept) return fileArray;

      const acceptTypes = accept.split(',').map((t) => t.trim().toLowerCase());
      return fileArray.filter((file) => {
        const ext = '.' + file.name.split('.').pop()?.toLowerCase();
        const mimeType = file.type.toLowerCase();
        return acceptTypes.some((type) => {
          if (type.startsWith('.')) {
            return ext === type;
          }
          if (type.endsWith('/*')) {
            return mimeType.startsWith(type.replace('/*', '/'));
          }
          return mimeType === type;
        });
      });
    },
    [accept]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragOver false when leaving the dropzone itself
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (e.dataTransfer.files.length > 0) {
        const files = filterFiles(e.dataTransfer.files);
        if (files.length > 0) {
          onFiles(multiple ? files : [files[0]]);
        }
      }
    },
    [filterFiles, onFiles, multiple]
  );

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        const files = filterFiles(e.target.files);
        if (files.length > 0) {
          onFiles(multiple ? files : [files[0]]);
        }
      }
      // Reset the input so the same file can be re-selected
      e.target.value = '';
    },
    [filterFiles, onFiles, multiple]
  );

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-3)',
    padding: 'var(--space-8) var(--space-6)',
    borderRadius: 'var(--radius-xl)',
    border: '2px dashed',
    borderColor: isDragOver ? 'var(--brand-primary)' : 'var(--border-secondary)',
    background: isDragOver ? 'var(--brand-light)' : 'var(--bg-secondary)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    minHeight: 160,
    outline: 'none',
    ...style,
  };

  const iconContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
    borderRadius: 'var(--radius-full)',
    background: isDragOver ? 'var(--brand-light)' : 'var(--bg-tertiary)',
    transition: 'background var(--transition-fast)',
  };

  return (
    <div
      className={cn('drop-zone', className)}
      style={containerStyle}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={label}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleFileChange}
        style={{ display: 'none' }}
        tabIndex={-1}
      />
      <div style={iconContainerStyle}>
        {isDragOver ? (
          <FileText size={22} style={{ color: 'var(--brand-primary)' }} />
        ) : (
          <Upload size={22} style={{ color: 'var(--text-tertiary)' }} />
        )}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-1)',
        }}
      >
        <span
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--font-medium)',
            color: isDragOver ? 'var(--brand-primary)' : 'var(--text-secondary)',
            transition: 'color var(--transition-fast)',
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          {hint}
        </span>
      </div>
      {accept && (
        <span
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--text-disabled)',
            marginTop: 'calc(-1 * var(--space-1))',
          }}
        >
          Accepted: {accept}
        </span>
      )}
    </div>
  );
}
