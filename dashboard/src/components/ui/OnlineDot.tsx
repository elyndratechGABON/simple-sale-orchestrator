// Pastille « en ligne / hors ligne ». Partagée : la même question se pose pour un
// commerce (au moins un de ses écrans répond) et pour un écran isolé — deux questions,
// un seul rendu.
export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span title={online ? "En ligne" : "Hors ligne"}>
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 8,
          marginRight: 6,
          background: online ? "#16a34a" : "#9ca3af",
        }}
      />
      {online ? "En ligne" : "Hors ligne"}
    </span>
  );
}