/** O que ainda não aconteceu, e o que faz acontecer. Nunca uma tabela vazia. */
export function Empty({ title, next }: { title: string; next: string }) {
  return (
    <div className="t-empty">
      <h2 className="t-empty__title">{title}</h2>
      <p className="t-empty__next">{next}</p>
    </div>
  );
}
