import type { ReactNode } from "react";

type Column<T> = {
  key: string;
  label: string;
  render?: (item: T) => ReactNode;
  className?: string;
};

type DataTableProps<T> = {
  columns: Column<T>[];
  data: T[];
  keyFn: (item: T) => string | number;
  emptyMessage?: string;
};

export function DataTable<T extends Record<string, any>>({ columns, data, keyFn, emptyMessage }: DataTableProps<T>) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.className}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={keyFn(item)}>
              {columns.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.render ? c.render(item) : item[c.key]}
                </td>
              ))}
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <div className="empty">{emptyMessage ?? "Aucune donn\u00e9e."}</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
