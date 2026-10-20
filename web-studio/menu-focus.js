// Reveal keyboard focus inside the popup only; scrolling the page can move
// the studio or a compact parent menu underneath the user's editing context.
export function focusMenuItem(button){
  if(!button)return;button.focus({preventScroll:true});
  const menu=button.closest('[role="menu"]');if(!menu)return;
  const row=button.getBoundingClientRect(),bounds=menu.getBoundingClientRect(),top=bounds.top+menu.clientTop,bottom=top+menu.clientHeight;
  if(row.top<top)menu.scrollTop+=row.top-top;
  else if(row.bottom>bottom)menu.scrollTop+=row.bottom-bottom;
}
