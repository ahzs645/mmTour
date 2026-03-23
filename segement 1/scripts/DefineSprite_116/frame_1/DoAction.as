function setFaded()
{
   isFaded = 1;
}
function setNotFaded()
{
   isFaded = 0;
}
function unSelect()
{
   if(isActive)
   {
      isActive = 0;
      gotoAndPlay(68);
   }
}
function activate()
{
   _parent.holdState = 1;
   isActive = 1;
   _parent.mc_easier.hideShots();
   _parent.mc_better.hideShots();
   _parent.inst_easier_icons.unSelect();
   _parent.inst_better_icons.unSelect();
   gotoAndPlay(36);
}
var isFaded;
var isActive;
isFaded = 0;
isActive = 0;
