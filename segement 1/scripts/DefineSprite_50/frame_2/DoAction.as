function showShots()
{
   _parent.playVO("TOUR73");
   gotoAndPlay(10);
}
function hideShots()
{
   if(_currentframe != 4)
   {
      gotoAndPlay(35);
   }
}
