import { xtz } from '../lib/format';

/**
 * Valor em XTZ: monoespaçado, tabular, seis casas, sempre.
 *
 * `bare` tira o símbolo da célula. Numa coluna em que toda linha é XTZ, o ꜩ
 * repetido oitenta vezes é ruído e afasta as colunas de números uma da outra —
 * a unidade sobe para o cabeçalho da coluna, onde é dita uma vez.
 */
export function Amount({ mutez, bare = false }: { mutez: bigint; bare?: boolean }) {
  return (
    <span className="t-amount">
      {xtz(mutez)}
      {!bare && <span className="t-amount__unit">ꜩ</span>}
    </span>
  );
}
