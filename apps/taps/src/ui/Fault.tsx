/**
 * Uma falha, dita inteira: o que falhou, onde, e o que deixou de ser conhecido.
 *
 * A terceira linha é a que não pode faltar. Foi um `|| 0` num campo da TzKT que
 * fez o sistema antigo pagar zero a todos os delegadores em silêncio; a versão
 * de tela desse mesmo erro é uma mensagem que diz "erro" e deixa a pessoa achar
 * que o número zero ao lado é verdade.
 */
export function Fault(props: { what: string; where: string; cost: string }) {
  return (
    <p className="t-fault" role="alert">
      <strong className="t-fault__what">{props.what}</strong>
      <span className="t-fault__where">{props.where}</span>
      <span className="t-fault__cost">{props.cost}</span>
    </p>
  );
}
