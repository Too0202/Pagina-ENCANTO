# Tienda de cosméticos con panel y revisión automática de agotados

## Qué hace

- **Tu tienda** (`index.html`): los clientes ven tus productos y piden por WhatsApp. Si un producto se agota, sale con la etiqueta **Agotado** (o desaparece, según `hideSoldOut` en `site.config.js`).
- **Tu panel** (`admin.html`, por ejemplo `https://tu-usuario.github.io/tu-repositorio/admin.html`): desde ahí agregas productos del catálogo del proveedor, cambias precios y fotos, agregas categorías del proveedor y personalizas tu tienda (nombre, logo, colores y letra). Se entra con usuario y contraseña.
- **El robot** (gratis, en GitHub): cada 30 minutos lee el catálogo del proveedor y actualiza tu tienda solo.

## Cuándo se marca un producto como agotado

El robot lee de sysvariedades los mismos datos que usa su página (la dirección `productos/load-more/N`). Cada producto se vigila por su número interno, no por su nombre. Se marca **Agotado** si el proveedor:
1. lo **elimina** (`deleted`),
2. lo **desactiva** (`product_inactive`),
3. deja de mostrarlo en el catálogo (después de 2 revisiones seguidas sin verlo, para evitar falsas alarmas), o
4. tiene su **cantidad en 0 o menos** (se puede apagar en el panel, pestaña "Categorías del proveedor").

Si el proveedor no responde o falla una categoría, el robot **no cambia nada**; nunca marca agotados por un error de conexión. Cuando el producto vuelve a estar disponible, vuelve a aparecer solo.

Ojo con la regla 4: en el catálogo del proveedor hay productos con cantidades negativas, que parecen errores de su inventario. Con la regla activa se verían como agotados. Si ves productos agotados que sí puedes conseguir, apaga esa regla en el panel.

## Puesta en marcha (una sola vez)

1. Crea una cuenta gratis en github.com y un repositorio **público** nuevo.
2. Sube todo el contenido de esta carpeta, **incluida la carpeta `.github`** (si no la ves, tu computador la esconde por empezar con punto).
3. Settings → Pages → Source: "Deploy from a branch" → rama `main`, carpeta `/ (root)`. Ahí te da la dirección de tu tienda.
4. Pestaña **Actions** → "Revisar disponibilidad del proveedor" → **Run workflow**. Así el robot trae por primera vez el catálogo (tarda 1 o 2 minutos). Si GitHub pide habilitar Actions, acéptalo.
5. Crea tu **token** para entrar al panel: en GitHub, Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Elige solo tu repositorio y en permisos pon **Contents: Read and write** y **Actions: Read and write**. Copia el texto `github_pat_...`.
6. Abre `admin.html` en tu tienda, escribe `tu-usuario/tu-repositorio`, pega el token y entra. Te lleva a la pestaña **Acceso**: crea ahí tu usuario y contraseña.
7. En **Apariencia** pon el nombre de tu tienda, tu logo, tu WhatsApp, los colores y la letra, y pulsa Guardar.
8. En **Agregar del proveedor** busca un producto, pulsa **Agregar**, ponle tu precio de venta y una foto. Listo: tu tienda se actualiza en 1 o 2 minutos.

El panel viene con la categoría **Cejas** (número 1). Para más categorías, ve a la pestaña "Categorías del proveedor", pega el link de la categoría (por ejemplo `https://sysvariedades.com.co/catalogoenlinea/public/products/2`) y pulsa "Revisar proveedor ahora".

## Entrar con usuario y contraseña

La primera vez entras con el token. En la pestaña **Acceso** creas un usuario y una contraseña; desde entonces entras solo con eso, desde cualquier equipo. Tu token se guarda **cifrado con tu contraseña** en el archivo `admin-vault.json` del repositorio.

Como el repositorio es público, ese archivo también lo es. Está cifrado, pero **si tu contraseña es fácil, alguien podría descifrarlo** y editar tu tienda. Usa una frase larga que no uses en ningún otro sitio (mínimo 10 caracteres). Si olvidas la contraseña o el token vence, entra con un token nuevo y crea otra contraseña.

## Apariencia

Pestaña **Apariencia**: nombre, logo (solo nombre, solo logo o ambos), título y frase de la portada, WhatsApp, colores (una combinación lista o tres colores a tu gusto) y tipo de letra, con vista previa en vivo. Si los colores hacen difícil leer, el panel te avisa. Los cambios se ven en tu tienda en uno o dos minutos.

## Stock propio
- En "Mis productos" cada producto tiene "Tu stock" con − y +. Se guarda solo.
- Si tienes stock (más de 0), el producto sigue a la venta aunque el proveedor lo oculte, lo desactive o lo quite.
- Si tu stock es 0, manda el proveedor: si lo oculta o lo quita, desaparece de tu tienda (o sale "Agotado" si no activaste ocultar agotados).
- El stock no baja solo cuando vendes: ajústalo tú después de cada venta.
- "Crear producto propio" sirve para lo que no viene del proveedor; se vende solo mientras tengas stock.

## Filtros, categorías, subcategorías y marcas
- El proveedor no entrega subcategoría ni marca: tú las escribes en cada producto (o varios a la vez: marca las casillas y pulsa "Cambiar categoría, marca…").
- La tienda arma sola los filtros (Categoría › Subcategoría, Marca, precio, solo disponibles).
- Escribe siempre igual los nombres; el panel reutiliza la forma ya escrita si cambia solo mayúsculas o tildes.

## Anuncio y banners
- Apariencia › "Anuncio y banners": barra superior y hasta 8 banners con imagen (1600 × 700), título, texto y botón.
- Cada banner puede llevar a una categoría (y subcategoría), a una marca o a un link.
- Sin banners se muestra el título grande de la portada.

## Carrito
Los clientes agregan productos, ajustan cantidades y envían el pedido por WhatsApp.

## Cuidados

- **El token es como una contraseña.** Se guarda solo en el navegador donde entraste. No lo compartas. Si lo pierdes o sospechas de él, bórralo en GitHub y crea otro.
- Como el repositorio es público, tu lista de productos y precios también lo es (igual que tu tienda). Los tokens no.
- Si el robot falla (verás una X roja en la pestaña Actions y GitHub te escribe), normalmente es que el proveedor cambió su página o bloqueó la conexión. En ese caso avisa para ajustarlo.
- GitHub pausa los robots programados si el repositorio pasa 60 días sin actividad. Con cambios desde el panel se mantiene activo; si se pausa, entra a Actions y pulsa "Enable workflow".

## Probar el robot en tu computador

```
node sync/check-stock.mjs
```

Muestra una línea por producto con el motivo de cada decisión. Requiere Node 18 o superior.
