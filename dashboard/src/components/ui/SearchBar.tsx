import { SearchIcon } from "../../icons";

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="search">
      <SearchIcon size={15} />
      <input
        type="search"
        placeholder={placeholder ?? "Rechercher\u2026"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Rechercher"
      />
    </div>
  );
}
