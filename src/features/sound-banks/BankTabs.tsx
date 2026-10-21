import type { SoundBank } from "./models";

interface BankTabsProps {
  banks: SoundBank[];
  activeBankId: string;
  onSelect: (id: string) => void;
  onManage: () => void;
  onCreate: () => void;
}

/**
 * Ofrece selección de bancos con botones nativos accesibles por Tab y Enter.
 * @param props Bancos ordenados y acciones visuales de navegación.
 * @returns Navegación horizontal desplazable y acciones de banco.
 */
export function BankTabs({
  banks,
  activeBankId,
  onSelect,
  onManage,
  onCreate,
}: BankTabsProps) {
  return (
    <nav aria-label="Bancos de sonidos" className="bank-navigation">
      <div className="bank-tabs">
        {banks.map((bank, index) => (
          <button
            key={bank.id}
            type="button"
            aria-pressed={bank.id === activeBankId}
            onClick={() => onSelect(bank.id)}
            className="bank-tab"
          >
            <span className="tab-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="truncate">{bank.name}</span>
            <span className="tab-count">{bank.buttons.length}</span>
          </button>
        ))}
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" className="control" onClick={onCreate}>
          + Banco
        </button>
        <button type="button" className="control" onClick={onManage}>
          Organizar bancos
        </button>
      </div>
    </nav>
  );
}
