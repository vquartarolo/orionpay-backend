export function mapStatus(status) {
  switch (status) {
    case "approved":
    case "completed":
      return "confirmed";

    case "pending":
      return "pending";

    case "failed":
      return "failed";

    case "cancelled":
      return "cancelled";

    case "expired":
      return "expired";

    default:
      return "pending";
  }
}

export function getStatusLabel(status) {
  switch (status) {
    case "confirmed":
      return "Confirmado";

    case "pending":
      return "Pendente";

    case "failed":
      return "Falhou";

    case "cancelled":
      return "Cancelado";

    case "expired":
      return "Expirado";

    default:
      return "Pendente";
  }
}