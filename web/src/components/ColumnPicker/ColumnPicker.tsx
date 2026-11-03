import React, { useState } from 'react';
import './ColumnPicker.css';

export interface ColumnOption {
  key: string;
  label: string;
}

export interface ColumnPickerProps {
  columns: ColumnOption[];
  selectedCols: Record<string, boolean>;
  onToggleCol: (key: string) => void;
  className?: string;
}

export const ColumnPicker: React.FC<ColumnPickerProps> = ({
  columns,
  selectedCols,
  onToggleCol,
  className,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className={`fqd-col-picker ${className || ''}`.trim()}>
      <button
        type="button"
        className="fqd-col-picker__btn"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Toggle visible columns"
      >
        Columns ?
      </button>

      {open && (
        <>
          <div
            className="fqd-col-picker__backdrop"
            onClick={() => setOpen(false)}
          />
          <div className="fqd-col-picker__dropdown" role="menu">
            <div className="fqd-col-picker__header">Toggle Columns</div>
            {columns.map((col) => (
              <label key={col.key} className="fqd-col-picker__option">
                <input
                  type="checkbox"
                  className="fqd-col-picker__checkbox"
                  checked={selectedCols[col.key] !== false}
                  onChange={() => onToggleCol(col.key)}
                />
                <span className="fqd-col-picker__label">{col.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
