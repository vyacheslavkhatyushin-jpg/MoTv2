/*
Точка расширения для уведомлений по тикетам. Пока no-op — транспорт (SMTP)
не подключён (см. задачу "настроить email-уведомления" в бэклоге), но вызовы
уже расставлены в server/routes/tickets.js в нужных местах (назначение,
новый комментарий, смена статуса), чтобы потом не переделывать логику
роутов, а просто подключить реальную отправку здесь.
*/
function notifyTicketEvent(event) {
  // event: { type: "assigned"|"comment"|"status_change"|"closed", ticket, actor, ... }
  // TODO: отправка email, когда будет настроен SMTP-транспорт.
}

module.exports = { notifyTicketEvent };
