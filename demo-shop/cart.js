// Demo shop cart. Contains a real bug for the Pawgents fixer to find and fix:
// a cart line whose product was unpublished makes cartTotal() throw, so checkout breaks.
function cartTotal(lines) {
  return lines.reduce(function (sum, line) {
    return sum + window.CATALOG[line.id].price * line.qty;
  }, 0);
}

function renderCart(lines) {
  var total = cartTotal(lines);
  document.getElementById('total').textContent = 'S$' + total.toFixed(2);
  document.getElementById('lines').textContent = lines.length + ' item' + (lines.length === 1 ? '' : 's');
}

window.cart = [{ id: 'rose-dawn', qty: 1 }];

function addToCart(id) {
  window.cart.push({ id: id, qty: 1 });
  renderCart(window.cart);
}
