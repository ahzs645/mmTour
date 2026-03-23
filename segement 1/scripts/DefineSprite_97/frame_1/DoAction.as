function showShots()
{
   _parent.playVO("TOUR63");
   gotoAndPlay(10);
}
function hideShots()
{
   if(_currentframe != 4)
   {
      gotoAndPlay(35);
   }
}
